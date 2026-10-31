import crypto from "crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceTimersByTimeAsync } from "@courier/testing";
import type { AcmeCertificateIssuer, AcmeIdentifier, ChallengeSink } from "../acme/client";
import {
  ACCOUNT_KEY_FILE,
  AcmeManager,
  CERTIFICATE_CHAIN_FILE,
  CERTIFICATE_KEY_FILE,
  LAST_ISSUANCE_FILE,
  type AcmeManagerOptions,
  type CertificatePair,
  MAX_RETRY_AFTER_FAILURE_MS,
  RENEW_BEFORE_MS,
  RENEW_CHECK_INTERVAL_MS,
  RETRY_AFTER_FAILURE_MS,
  certificateNeedsIssue,
  renewBeforeMs,
} from "./acme-manager";

/** A real self-signed pair for `IP:127.0.0.1` + `DNS:localhost` (valid to 2076). */
const FIXTURE_CERT = readFileSync(
  fileURLToPath(new URL("./__fixtures__/cert.pem", import.meta.url)),
  "utf8",
);
const FIXTURE_KEY = readFileSync(
  fileURLToPath(new URL("./__fixtures__/key.pem", import.meta.url)),
  "utf8",
);
/**
 * The manager writes back whatever the issuer returns, so a marker chain makes
 * "the file was written by this attempt" observable without needing a second
 * real certificate.
 */
const CHAIN_ONE = "-----BEGIN CERTIFICATE-----\nZmFrZS1vbmU=\n-----END CERTIFICATE-----\n";
const CHAIN_TWO = "-----BEGIN CERTIFICATE-----\nZmFrZS10d28=\n-----END CERTIFICATE-----\n";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "courier-tls-test-"));
  dirs.push(dir);
  return dir;
}

function seed(dir: string, cert: string, key: string): void {
  writeFileSync(join(dir, CERTIFICATE_CHAIN_FILE), cert);
  writeFileSync(join(dir, CERTIFICATE_KEY_FILE), key);
}

function freshKeyPem(): string {
  return crypto
    .generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
}

/** A promise and its resolver, for tests that need an issuance in flight. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  const state: { settle?: () => void } = {};
  const promise = new Promise<void>((settle) => {
    state.settle = settle;
  });
  return { promise, resolve: () => state.settle?.() };
}

/** An issuer that records what it was asked for and returns a chain or a failure. */
class FakeIssuer implements AcmeCertificateIssuer {
  readonly requests: { identifier: AcmeIdentifier; csrDer: Buffer }[] = [];
  readonly accountKeys: string[] = [];
  chain = FIXTURE_CERT;
  failure: Error | null = null;
  /** Runs inside `obtainCertificate`, before it answers. */
  onCall: ((sink: ChallengeSink) => void) | null = null;
  /** When set, `obtainCertificate` waits for it — an issuance in flight. */
  gate: Promise<void> | null = null;

  async obtainCertificate(
    request: { identifier: AcmeIdentifier; csrDer: Buffer },
    sink: ChallengeSink,
  ): Promise<string> {
    this.requests.push(request);
    if (this.failure) throw this.failure;
    this.onCall?.(sink);
    if (this.gate) await this.gate;
    return this.chain;
  }
}

function managerFor(
  dir: string,
  issuer: FakeIssuer,
  now: () => number,
  extra: Partial<
    Pick<AcmeManagerOptions, "name" | "onCertificate" | "ensureChallengeListener">
  > = {},
): AcmeManager {
  return new AcmeManager({
    name: "127.0.0.1",
    dir,
    directoryUrl: "https://acme.test/directory",
    clientFactory: (accountPrivateKeyPem) => {
      issuer.accountKeys.push(accountPrivateKeyPem);
      return issuer;
    },
    now,
    ...extra,
  });
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the renewal window", () => {
  it("renews only inside the 72-hour window", () => {
    const now = 1_700_000_000_000;
    expect(renewBeforeMs(null, now)).toBe(true);
    expect(renewBeforeMs(now + RENEW_BEFORE_MS + 1, now)).toBe(false);
    expect(renewBeforeMs(now + RENEW_BEFORE_MS, now)).toBe(true);
    expect(renewBeforeMs(now - 1, now)).toBe(true);
  });

  it("reads the expiry out of the chain on disk", () => {
    const expiresAt = new crypto.X509Certificate(FIXTURE_CERT).validToDate.getTime();
    expect(certificateNeedsIssue(FIXTURE_CERT, expiresAt - RENEW_BEFORE_MS - 1)).toBe(false);
    expect(certificateNeedsIssue(FIXTURE_CERT, expiresAt - RENEW_BEFORE_MS + 1)).toBe(true);
    expect(certificateNeedsIssue(null, Date.now())).toBe(true);
    expect(certificateNeedsIssue("not a certificate", Date.now())).toBe(true);
  });
});

describe("AcmeManager — the state on disk", () => {
  it("serves a valid pair instead of re-issuing it", async () => {
    const dir = tempDir();
    seed(dir, FIXTURE_CERT, FIXTURE_KEY);
    const issuer = new FakeIssuer();
    const expiresAt = new crypto.X509Certificate(FIXTURE_CERT).validToDate.getTime();
    const manager = managerFor(dir, issuer, () => expiresAt - 2 * RENEW_BEFORE_MS);

    expect(manager.loadOrNull()).toEqual({ cert: FIXTURE_CERT, key: FIXTURE_KEY });
    expect(manager.currentCertificate()).toEqual({ cert: FIXTURE_CERT, key: FIXTURE_KEY });
    await expect(manager.maybeIssue()).resolves.toBe(false);
    expect(issuer.requests).toHaveLength(0);
  });

  it("treats a chain/key pair that does not match as absent and issues instead", async () => {
    const dir = tempDir();
    // The fixture chain with a key that does not belong to it: exactly what a
    // botched manual copy onto the server looks like.
    seed(dir, FIXTURE_CERT, freshKeyPem());
    const issuer = new FakeIssuer();
    const manager = managerFor(dir, issuer, () => Date.now());

    // The listener can only be built from a usable pair, so this must be null
    // rather than something `https.createServer` would throw on.
    expect(manager.loadOrNull()).toBeNull();
    expect(manager.currentCertificate()).toBeNull();
    await expect(manager.maybeIssue()).resolves.toBe(true);
    expect(issuer.requests).toHaveLength(1);
    expect(readFileSync(join(dir, CERTIFICATE_CHAIN_FILE), "utf8")).toBe(FIXTURE_CERT);
  });

  it("replaces a corrupt certificate key instead of failing every renewal", async () => {
    const dir = tempDir();
    seed(dir, FIXTURE_CERT, "-----BEGIN PRIVATE KEY-----\nnot base64\n-----END PRIVATE KEY-----\n");
    const issuer = new FakeIssuer();
    const manager = managerFor(dir, issuer, () => Date.now());

    expect(manager.loadOrNull()).toBeNull();
    await expect(manager.maybeIssue()).resolves.toBe(true);

    const key = readFileSync(join(dir, CERTIFICATE_KEY_FILE), "utf8");
    expect(key).not.toContain("not base64");
    expect(() => crypto.createPrivateKey(key)).not.toThrow();
  });

  it("replaces a corrupt account key before talking to ACME", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, ACCOUNT_KEY_FILE), "garbage, not a PEM\n");
    const issuer = new FakeIssuer();
    const manager = managerFor(dir, issuer, () => Date.now());

    await manager.issue();

    expect(issuer.accountKeys).toHaveLength(1);
    expect(() => crypto.createPrivateKey(issuer.accountKeys[0])).not.toThrow();
    expect(readFileSync(join(dir, ACCOUNT_KEY_FILE), "utf8")).not.toContain("garbage");
  });

  it("generates the keys once, keeps them 0600, and swaps the certificate in", async () => {
    const dir = tempDir();
    const issuer = new FakeIssuer();
    const swaps: CertificatePair[] = [];
    const manager = managerFor(dir, issuer, () => Date.now(), {
      onCertificate: (pair) => swaps.push(pair),
    });

    await manager.issue();
    const accountKey = readFileSync(join(dir, ACCOUNT_KEY_FILE), "utf8");
    const certificateKey = readFileSync(join(dir, CERTIFICATE_KEY_FILE), "utf8");
    expect(() => crypto.createPrivateKey(accountKey)).not.toThrow();
    expect(() => crypto.createPrivateKey(certificateKey)).not.toThrow();
    if (process.platform !== "win32") {
      // Windows has no POSIX modes, so the check only means something elsewhere.
      expect(statSync(join(dir, ACCOUNT_KEY_FILE)).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, CERTIFICATE_KEY_FILE)).mode & 0o777).toBe(0o600);
    }

    await manager.issue();

    // A renewal reuses both keys — only the chain changes.
    expect(readFileSync(join(dir, ACCOUNT_KEY_FILE), "utf8")).toBe(accountKey);
    expect(readFileSync(join(dir, CERTIFICATE_KEY_FILE), "utf8")).toBe(certificateKey);
    expect(issuer.accountKeys).toEqual([accountKey, accountKey]);
    expect(swaps).toHaveLength(2);
    expect(swaps[0]).toEqual({ cert: FIXTURE_CERT, key: certificateKey });
    // Every write went through a rename, so nothing temporary is left behind.
    expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("builds the CSR for the identifier in TLS_NAME, from the key on disk", async () => {
    const dir = tempDir();
    const issuer = new FakeIssuer();
    const manager = managerFor(dir, issuer, () => Date.now(), { name: "vault.example.com" });

    expect(manager.identifier).toEqual({ type: "dns", value: "vault.example.com" });
    await manager.issue();

    const csr = issuer.requests[0].csrDer;
    expect(issuer.requests[0].identifier).toEqual({ type: "dns", value: "vault.example.com" });
    expect(csr.includes(Buffer.from("vault.example.com"))).toBe(true);
    // The CSR's public key is the certificate key on disk.
    const spki = crypto
      .createPublicKey(readFileSync(join(dir, CERTIFICATE_KEY_FILE), "utf8"))
      .export({ type: "spki", format: "der" });
    expect(csr.includes(spki)).toBe(true);

    // An IP name takes the RFC 8738 path instead.
    const ipManager = managerFor(tempDir(), new FakeIssuer(), () => Date.now(), {
      name: "203.0.113.9",
    });
    expect(ipManager.identifier).toEqual({ type: "ip", value: "203.0.113.9" });
    expect(() => new AcmeManager({ name: "   ", dir, directoryUrl: "https://acme.test" })).toThrow(
      /TLS_NAME/,
    );
  });
});

describe("AcmeManager — issuance", () => {
  it("runs a single issuance for concurrent callers", async () => {
    const dir = tempDir();
    const issuer = new FakeIssuer();
    const gate = deferred();
    issuer.gate = gate.promise;
    const manager = managerFor(dir, issuer, () => Date.now());

    const first = manager.maybeIssue();
    const second = manager.maybeIssue();
    await new Promise((resolve) => setImmediate(resolve));
    expect(issuer.requests).toHaveLength(1);

    gate.resolve();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(issuer.requests).toHaveLength(1);
    expect(manager.currentCertificate()?.cert).toBe(FIXTURE_CERT);
  });

  it("brings the challenge listener up before starting an order", async () => {
    const dir = tempDir();
    const calls: string[] = [];
    const issuer = new FakeIssuer();
    issuer.onCall = () => calls.push("order");
    const manager = managerFor(dir, issuer, () => Date.now(), {
      ensureChallengeListener: async () => {
        calls.push("listener");
      },
    });

    await expect(manager.maybeIssue()).resolves.toBe(true);
    expect(calls).toEqual(["listener", "order"]);
  });

  it("reports a challenge listener that cannot bind without throwing", async () => {
    const issuer = new FakeIssuer();
    const manager = managerFor(tempDir(), issuer, () => Date.now(), {
      ensureChallengeListener: async () => {
        throw new Error("listen EACCES: permission denied 0.0.0.0:80");
      },
    });

    await expect(manager.maybeIssue()).resolves.toBe(false);
    expect(issuer.requests).toHaveLength(0);
  });

  it("serves a challenge response only while an order has it in flight", async () => {
    const dir = tempDir();
    const issuer = new FakeIssuer();
    const seen: (string | null)[] = [];
    let manager: AcmeManager;
    issuer.onCall = (sink) => {
      sink.register("tok", "tok.thumbprint");
      seen.push(manager.challengeResponse("tok"));
      sink.release("tok");
      seen.push(manager.challengeResponse("tok"));
    };
    manager = managerFor(dir, issuer, () => Date.now());

    await manager.issue();
    expect(seen).toEqual(["tok.thumbprint", null]);
  });

  it("keeps the previous certificate when an issuance fails, and retries later", async () => {
    const dir = tempDir();
    const issuer = new FakeIssuer();
    const swaps: CertificatePair[] = [];
    const manager = managerFor(dir, issuer, () => Date.now(), {
      onCertificate: (pair) => swaps.push(pair),
    });

    issuer.chain = CHAIN_ONE;
    await expect(manager.maybeIssue()).resolves.toBe(true);
    expect(readFileSync(join(dir, CERTIFICATE_CHAIN_FILE), "utf8")).toBe(CHAIN_ONE);

    issuer.failure = new Error(
      "the ACME request to https://acme.test/new-order failed: ECONNREFUSED",
    );
    await expect(manager.maybeIssue()).resolves.toBe(false);
    // The previous chain is still on disk and still what the listener serves.
    expect(readFileSync(join(dir, CERTIFICATE_CHAIN_FILE), "utf8")).toBe(CHAIN_ONE);
    expect(manager.currentCertificate()?.cert).toBe(CHAIN_ONE);
    expect(swaps).toHaveLength(1);

    // The next check issues again.
    issuer.failure = null;
    issuer.chain = CHAIN_TWO;
    await expect(manager.maybeIssue()).resolves.toBe(true);
    expect(readFileSync(join(dir, CERTIFICATE_CHAIN_FILE), "utf8")).toBe(CHAIN_TWO);
    expect(manager.currentCertificate()?.cert).toBe(CHAIN_TWO);
    expect(swaps).toHaveLength(2);
    expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  // The service logs issuance to the journal, and a machine without journald has
  // nowhere to look — which is exactly when "the certificate never appeared"
  // needs to say why. One line beside the keys, readable with `cat`.
  it("keeps the last issuance outcome beside the certificate state", async () => {
    const dir = tempDir();
    const issuer = new FakeIssuer();
    issuer.failure = new Error(
      "the ACME request to https://acme.test/new-order failed: socket hang up",
    );
    const manager = managerFor(dir, issuer, () => Date.UTC(2026, 9, 14, 19, 28, 0));

    await expect(manager.maybeIssue()).resolves.toBe(false);
    const failure = readFileSync(join(dir, LAST_ISSUANCE_FILE), "utf8").trim();
    expect(failure).toBe(
      "2026-10-14T19:28:00.000Z failed: the ACME request to https://acme.test/new-order failed: socket hang up",
    );

    // A later success replaces it, so the file always describes the last attempt.
    issuer.failure = null;
    issuer.chain = FIXTURE_CERT;
    await expect(manager.maybeIssue()).resolves.toBe(true);
    const issued = readFileSync(join(dir, LAST_ISSUANCE_FILE), "utf8").trim();
    expect(issued).toMatch(/^2026-10-14T19:28:00\.000Z issued, valid until /);
  });

  it("re-checks on a six-hour timer until it is stopped", async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const issuer = new FakeIssuer();
    // A marker chain never parses as a certificate, so every check renews — the
    // point here is the cadence, not the decision.
    issuer.chain = CHAIN_ONE;
    const manager = managerFor(dir, issuer, () => Date.now());

    manager.start();
    await advanceTimersByTimeAsync(0);
    expect(issuer.requests).toHaveLength(1);

    await advanceTimersByTimeAsync(RENEW_CHECK_INTERVAL_MS);
    expect(issuer.requests).toHaveLength(2);

    manager.stop();
    await advanceTimersByTimeAsync(RENEW_CHECK_INTERVAL_MS * 2);
    expect(issuer.requests).toHaveLength(2);
  });

  it("retries a failed issuance long before the renewal cadence, then settles back", async () => {
    vi.useFakeTimers();
    try {
      const dir = tempDir();
      const issuer = new FakeIssuer();
      issuer.failure = new Error(
        "the ACME authorization for ip 203.0.113.7 failed: connection refused",
      );
      const manager = managerFor(dir, issuer, () => Date.now());

      manager.start();
      await advanceTimersByTimeAsync(0);
      expect(issuer.requests).toHaveLength(1);

      // Ten minutes, not six hours: an operator who has just been told to open
      // port 80 is watching this, and the certificate needs port 80 to exist.
      await advanceTimersByTimeAsync(RETRY_AFTER_FAILURE_MS);
      expect(issuer.requests).toHaveLength(2);

      // Each further failure waits longer…
      await advanceTimersByTimeAsync(RETRY_AFTER_FAILURE_MS * 2);
      expect(issuer.requests).toHaveLength(3);
      await advanceTimersByTimeAsync(RETRY_AFTER_FAILURE_MS * 4);
      expect(issuer.requests).toHaveLength(4);

      // …up to the ceiling, which keeps the account inside Let's Encrypt's
      // five-failed-validations-per-hour budget for one identifier.
      await advanceTimersByTimeAsync(MAX_RETRY_AFTER_FAILURE_MS);
      expect(issuer.requests).toHaveLength(5);
      await advanceTimersByTimeAsync(MAX_RETRY_AFTER_FAILURE_MS);
      expect(issuer.requests).toHaveLength(6);

      // A success ends the backoff: the next check is the renewal cadence again.
      issuer.failure = null;
      issuer.chain = CHAIN_TWO;
      await advanceTimersByTimeAsync(MAX_RETRY_AFTER_FAILURE_MS);
      expect(manager.currentCertificate()?.cert).toBe(CHAIN_TWO);
      const attempts = issuer.requests.length;

      await advanceTimersByTimeAsync(RENEW_CHECK_INTERVAL_MS - RETRY_AFTER_FAILURE_MS);
      expect(issuer.requests).toHaveLength(attempts);
      await advanceTimersByTimeAsync(RETRY_AFTER_FAILURE_MS);
      expect(issuer.requests).toHaveLength(attempts + 1);

      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

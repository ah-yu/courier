import crypto from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { isIP } from "net";
import { join } from "path";
import tls from "tls";
import {
  AcmeClient,
  type AcmeCertificateIssuer,
  type AcmeIdentifier,
  type ChallengeSink,
} from "../acme/client";
import { info } from "../output";
import { createCertificateRequest } from "./csr";

/**
 * Owns everything about the service's certificate: the keys and the chain on
 * disk, the background issuance/renewal loop, and the challenge responses an
 * in-flight http-01 order needs.
 *
 * The manager never touches the listener itself — `start.ts` hands it an
 * `onCertificate` callback (`server.setSecureContext`) and an
 * `ensureChallengeListener` hook, so this file stays testable without sockets.
 */

/** The account key: one ACME account per service, reused across renewals. */
export const ACCOUNT_KEY_FILE = "account.key";
/** The certificate key. Kept across renewals so `setSecureContext` can reuse it. */
export const CERTIFICATE_KEY_FILE = "privkey.pem";
/** Leaf first, then the intermediates. */
export const CERTIFICATE_CHAIN_FILE = "fullchain.pem";
/**
 * One line per issuance attempt: when it ran, and how it ended. It is what an
 * operator reads when the service has no journal to read (see `recordOutcome`).
 */
export const LAST_ISSUANCE_FILE = "last-issuance.txt";

/**
 * How long before expiry a certificate is replaced. Let's Encrypt IP
 * certificates live 160 hours, so a 72-hour window renews roughly every 3.7
 * days while leaving room for a few failed attempts.
 */
export const RENEW_BEFORE_MS = 72 * 60 * 60 * 1000;
/** How often the loop re-checks the certificate on disk. */
export const RENEW_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * How long to wait before trying again after a **failed** issuance, doubling on
 * every further failure up to `MAX_RETRY_AFTER_FAILURE_MS`.
 *
 * The wait matters most for a first issuance: the deployment has just told the
 * operator to open port 80, and making that a six-hour experiment ("open it and
 * see") is not what anybody would call a retry.
 *
 * The ceiling is not politeness: Let's Encrypt refuses an account after five
 * failed validations for one identifier within the hour, so retrying every
 * couple of minutes would spend that budget and lock the name out for the rest
 * of it. Ten minutes, then twenty, then forty, then hourly stays well inside.
 */
export const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
/** Ceiling for the retry backoff above. */
export const MAX_RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

/**
 * The pure renewal decision: must a certificate that expires at `expiresAtMs`
 * be replaced at `nowMs`? `null` means there is no certificate at all.
 */
export function renewBeforeMs(expiresAtMs: number | null, nowMs: number): boolean {
  if (expiresAtMs === null) return true;
  return nowMs >= expiresAtMs - RENEW_BEFORE_MS;
}

/**
 * The renewal decision for a PEM chain: unreadable counts as "needs issuing".
 *
 * With `identifier`, a chain issued for a different address counts too. The TLS
 * state outlives a service deletion, so a certificate can outlive the address it
 * was issued for; without this check the service would keep serving a
 * certificate for the old address until it expired.
 */
export function certificateNeedsIssue(
  certPem: string | null,
  now: number,
  identifier?: AcmeIdentifier,
): boolean {
  if (!certPem) return true;
  try {
    const certificate = new crypto.X509Certificate(certPem);
    if (identifier && !certificateMatches(certificate, identifier)) return true;
    return renewBeforeMs(certificate.validToDate.getTime(), now);
  } catch {
    // A truncated or foreign file is not a certificate this process can serve.
    return true;
  }
}

/**
 * Whether a chain is for the identifier this service answers for.
 *
 * The runtime's own matchers are preferred: `checkIP` compares canonical IPs (an
 * IPv6 identifier may be written expanded while the SAN is compressed) and
 * `checkHost` handles IDNA and wildcards. The rendered SAN text is only a
 * fallback for a runtime without them; a certificate that lists no SAN at all
 * cannot be for this address, so it does not match.
 */
function certificateMatches(
  certificate: crypto.X509Certificate,
  identifier: AcmeIdentifier,
): boolean {
  const checks = certificate as unknown as {
    // Node answers a boolean; Bun answers the matched SAN text. Both are
    // truthy exactly when the name is in the chain.
    checkIP?: (ip: string) => string | boolean | undefined;
    checkHost?: (host: string) => string | undefined;
  };
  try {
    if (identifier.type === "ip" && typeof checks.checkIP === "function") {
      return Boolean(checks.checkIP(identifier.value));
    }
    if (identifier.type === "dns" && typeof checks.checkHost === "function") {
      return Boolean(checks.checkHost(identifier.value));
    }
  } catch {
    // A value the matcher refuses (a malformed identifier) is not in the chain.
    return false;
  }
  const names = certificate.subjectAltName;
  if (!names) return false;
  const wanted = `${identifier.type === "ip" ? "ip address" : "dns"}:${identifier.value}`;
  return names
    .toLowerCase()
    .split(/\s*,\s*/)
    .includes(wanted.toLowerCase());
}

/** The certificate a listener serves: a PEM chain and its private key. */
export interface CertificatePair {
  cert: string;
  key: string;
}

export interface AcmeManagerOptions {
  /** The identifier the certificate is issued for: an IP literal or a DNS name. */
  name: string;
  /** Optional ACME account contact (`mailto:` is added when missing). */
  email?: string;
  /** Directory holding the account key, the certificate key and the chain. */
  dir: string;
  directoryUrl: string;
  /** Builds a client for the given account key PEM; tests inject a fake issuer. */
  clientFactory?: (accountPrivateKeyPem: string) => AcmeCertificateIssuer;
  /** Called after a new chain is on disk, to swap it into a running listener. */
  onCertificate?: (certificate: CertificatePair) => void;
  /** Brings the http-01 listener up before an issuance is attempted. */
  ensureChallengeListener?: () => Promise<void>;
  now?: () => number;
}

export class AcmeManager implements ChallengeSink {
  /** What the certificate is for, derived from `TLS_NAME`. */
  readonly identifier: AcmeIdentifier;

  private readonly options: AcmeManagerOptions;
  private readonly nowFn: () => number;
  /** challenge token → key authorization, for the http-01 listener. */
  private readonly tokens = new Map<string, string>();
  private current: CertificatePair | null;
  private inFlight: Promise<void> | null = null;
  private timer: Timer | null = null;
  /** Issuance failures in a row, for the retry backoff. */
  private failures = 0;

  constructor(options: AcmeManagerOptions) {
    this.options = options;
    this.identifier = parseIdentifier(options.name);
    this.nowFn = options.now ?? (() => Date.now());
    this.current = this.loadOrNull();
  }

  /** The certificate pair already on disk, or null when there is none (yet). */
  loadOrNull(): CertificatePair | null {
    const cert = readTextIfExists(join(this.options.dir, CERTIFICATE_CHAIN_FILE));
    const key = readTextIfExists(join(this.options.dir, CERTIFICATE_KEY_FILE));
    if (!cert || !key) return null;
    try {
      // The listener is built from this pair with `https.createServer`, which
      // parses both synchronously and throws on a truncated chain, a PEM mix-up
      // or a key that does not match the chain. A service that refuses to start
      // is far worse than one that re-issues, so an unusable pair — and a pair
      // whose files were replaced by hand — counts as absent.
      tls.createSecureContext({ cert, key });
    } catch (error) {
      info(
        `tls: the certificate pair in ${this.options.dir} is unusable (${errorText(error)}); ` +
          `ignoring it and issuing a new certificate for ${this.identifier.value}`,
      );
      return null;
    }
    return { cert, key };
  }

  /** What the listener should be serving right now. */
  currentCertificate(): CertificatePair | null {
    return this.current;
  }

  /** Whether a chain (or its absence) requires an issuance at `now`. */
  needsIssue(certPem: string | null, now: number): boolean {
    return certificateNeedsIssue(certPem, now, this.identifier);
  }

  /** The body to serve for a challenge token, or null when it is not in flight. */
  challengeResponse(token: string): string | null {
    return this.tokens.get(token) ?? null;
  }

  // ── ChallengeSink: what an order registers while it is being validated ──

  register(token: string, keyAuthorization: string): void {
    this.tokens.set(token, keyAuthorization);
  }

  release(token: string): void {
    this.tokens.delete(token);
  }

  /**
   * Begin background issuance and the renewal checks. Returns immediately; the
   * loop is single-flight, so a check that lands while an issuance is running
   * joins it instead of starting a second order.
   */
  start(): void {
    if (this.timer) return;
    void this.check();
  }

  /** Stop the loop and forget any challenge token still registered. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.failures = 0;
    this.tokens.clear();
  }

  /**
   * One scheduled check: issue when it is needed, then arrange the next check —
   * six hours later when nothing needs doing or the issuance worked, and after
   * the failure backoff when it did not.
   */
  private async check(): Promise<void> {
    const needed = this.needsIssue(this.current?.cert ?? null, this.nowFn());
    const issued = await this.maybeIssue();
    if (!needed || issued) {
      this.failures = 0;
      this.schedule(RENEW_CHECK_INTERVAL_MS);
      return;
    }
    this.failures += 1;
    const delay = this.retryDelay();
    info(`acme: trying again in ${Math.round(delay / 60_000)} minute(s)`);
    this.schedule(delay);
  }

  /** The wait before the next attempt after `failures` failures in a row. */
  private retryDelay(): number {
    return Math.min(RETRY_AFTER_FAILURE_MS * 2 ** (this.failures - 1), MAX_RETRY_AFTER_FAILURE_MS);
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.check();
    }, delayMs);
    // A renewal loop must never keep the process (or a test run) alive.
    this.timer.unref?.();
  }

  /**
   * Issue only when there is no certificate or it is inside the renewal window.
   * A failure is logged and swallowed: the previous certificate keeps working
   * until it really expires, and the loop retries — after the backoff on a
   * first issuance, at the renewal cadence otherwise.
   */
  async maybeIssue(): Promise<boolean> {
    if (!this.needsIssue(this.current?.cert ?? null, this.nowFn())) return false;
    try {
      await this.issue();
      return true;
    } catch (error) {
      const reason = errorText(error);
      info(`acme: issuance for ${this.identifier.value} failed: ${reason}`);
      info(FAILURE_HINTS);
      this.recordOutcome(`failed: ${reason}`);
      return false;
    }
  }

  /**
   * Keep the last outcome beside the certificate state.
   *
   * The service logs issuance through the journal, which is where a headless
   * operator reads it — but a machine without journald (`Storage=none`, or a
   * container) has nowhere to look, and "the certificate never appeared" is then
   * a dead end. One line, next to the keys it is about, is readable with `cat`
   * over the same SSH connection the deployment tooling already has.
   */
  private recordOutcome(outcome: string): void {
    try {
      writeFileAtomic(
        join(this.options.dir, LAST_ISSUANCE_FILE),
        `${new Date(this.nowFn()).toISOString()} ${outcome}\n`,
        0o644,
        this.options.dir,
      );
    } catch {
      // A log line that cannot be written must never fail the issuance that
      // produced it.
    }
  }

  /**
   * Run one issuance now. Concurrent callers share a single run: two orders at
   * once would race over the same account key and challenge tokens, and the ACME
   * server would see two orders for one identifier.
   */
  async issue(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.runIssue().finally(() => {
        this.inFlight = null;
      });
    }
    return await this.inFlight;
  }

  private async runIssue(): Promise<void> {
    // The challenge listener is what ACME fetches; on a renewal the port has to
    // be bound again before the order can be validated.
    await this.options.ensureChallengeListener?.();

    const accountKey = this.loadOrCreateKey(ACCOUNT_KEY_FILE);
    const certificateKey = this.loadOrCreateKey(CERTIFICATE_KEY_FILE);
    // One identifier in, one SAN entry out: Let's Encrypt rejects a CSR whose
    // SAN set differs from what the order asked for.
    const csrDer = createCertificateRequest({
      privateKeyPem: certificateKey,
      ...(this.identifier.type === "ip"
        ? { ip: this.identifier.value }
        : { dns: this.identifier.value }),
    });

    const client = (this.options.clientFactory ?? defaultClientFactory(this.options))(accountKey);
    info(
      `acme: requesting a certificate for ${this.identifier.value} from ${this.options.directoryUrl}`,
    );
    const chain = await client.obtainCertificate({ identifier: this.identifier, csrDer }, this);

    writeFileAtomic(join(this.options.dir, CERTIFICATE_CHAIN_FILE), chain, 0o644, this.options.dir);
    const pair: CertificatePair = { cert: chain, key: certificateKey };
    this.current = pair;
    this.options.onCertificate?.(pair);
    const expiry = describeExpiry(chain);
    info(`acme: certificate for ${this.identifier.value} issued, valid until ${expiry}`);
    this.recordOutcome(`issued, valid until ${expiry}`);
  }

  /** Load a P-256 key, or generate it once and keep it for every renewal. */
  private loadOrCreateKey(fileName: string): string {
    const file = join(this.options.dir, fileName);
    const existing = readTextIfExists(file);
    if (existing) {
      try {
        // Verify the PEM while there is still a chance to replace it: a truncated
        // or foreign key would otherwise fail the CSR — and the renewal — every
        // six hours, forever.
        crypto.createPrivateKey(existing);
        return existing;
      } catch (error) {
        info(`acme: ${file} is not a usable private key (${errorText(error)}); replacing it`);
      }
    }
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    writeFileAtomic(file, pem, 0o600, this.options.dir);
    info(`acme: generated a new P-256 key at ${file}`);
    return pem;
  }
}

/**
 * What to look at when issuance fails. The three causes below cover almost every
 * real failure, and none of them is visible from inside the process.
 */
const FAILURE_HINTS =
  "acme: check that TCP port 80 reaches this machine (cloud security group and host firewall), " +
  "that nothing else is listening on port 80, and that the ACME directory is reachable";

function defaultClientFactory(options: AcmeManagerOptions): (accountKeyPem: string) => AcmeClient {
  return (accountPrivateKeyPem) =>
    new AcmeClient({
      directoryUrl: options.directoryUrl,
      accountPrivateKeyPem,
      contactEmail: options.email,
    });
}

/** `TLS_NAME` is either an IP literal (RFC 8738 order) or a DNS name. */
function parseIdentifier(name: string): AcmeIdentifier {
  const value = name.trim();
  if (value === "") {
    throw new Error("TLS_NAME must name the IP address or DNS name the service is reached at");
  }
  return isIP(value) ? { type: "ip", value } : { type: "dns", value };
}

function readTextIfExists(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/**
 * Write through a temporary file and rename it into place: a crash must never
 * leave a half-written key or chain where the listener would pick it up.
 */
function writeFileAtomic(file: string, content: string, mode: number, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, content, { mode });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function describeExpiry(chain: string): string {
  try {
    return new crypto.X509Certificate(chain).validToDate.toISOString();
  } catch {
    return "an unknown date";
  }
}

/** One line for an error, keeping the cause that carries the real reason. */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  const causeText =
    cause instanceof Error ? cause.message : cause === undefined ? "" : String(cause);
  // Skipping a cause the message already quotes keeps a re-wrapped error from
  // reading like `… (connect ECONNREFUSED …) (fetch failed)`.
  return causeText === "" || error.message.includes(causeText)
    ? error.message
    : `${error.message} (${causeText})`;
}

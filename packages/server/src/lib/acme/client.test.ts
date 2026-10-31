import crypto from "crypto";
import http from "http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCertificateRequest } from "../tls/csr";
import { AcmeClient, type ChallengeSink } from "./client";
import { base64urlDecode, jwkThumbprint, publicJwk, type Jwk } from "./jws";

/**
 * The client is exercised against a small fake ACME server that speaks the real
 * protocol over a real socket: it hands out nonces, checks nothing but records
 * every JWS, and fetches the http-01 file from a second in-process listener
 * exactly as Let's Encrypt does. Nothing is mocked away except the CA itself.
 */

const TOKEN = "tok-1";
const CERTIFICATE_URL_PATH = "/cert/1";
/** Two PEM blocks, so "a chain" is visibly more than a leaf. */
const FAKE_CHAIN =
  [
    "-----BEGIN CERTIFICATE-----",
    "ZmFrZS1sZWFm",
    "-----END CERTIFICATE-----",
    "-----BEGIN CERTIFICATE-----",
    "ZmFrZS1pbnRlcm1lZGlhdGU=",
    "-----END CERTIFICATE-----",
  ].join("\n") + "\n";

interface RecordedRequest {
  path: string;
  /** The decoded protected header. */
  header: Record<string, unknown>;
  /** The base64url payload as sent: "" for a POST-as-GET. */
  payloadB64: string;
  /** The decoded payload text. */
  payload: string;
  signature: Buffer;
  protectedB64: string;
}

interface FakeOptions {
  /** `null` models a directory that does not advertise the shortlived profile. */
  profiles?: Record<string, string> | null;
  /** Answer the first N `newOrder` POSTs with `badNonce`. */
  badNonceOnNewOrder?: number;
  /** Answer the first N `newOrder` POSTs with 429 + `Retry-After: 5`. */
  rateLimitOnNewOrder?: number;
  /** The `Retry-After` (seconds) those 429 answers carry. Defaults to 5. */
  rateLimitRetryAfter?: string;
  /** Fail the http-01 authorization with this problem detail. */
  authorizationFailure?: string;
  /** Answer this many order polls with `processing` before the order is valid. */
  orderProcessingPolls?: number;
  /**
   * Kill the connection before answering the first N POSTs to a path. This is
   * what a dropped request looks like — no ACME problem document, just a dead
   * socket — and it is the failure a client talking to Let's Encrypt across an
   * unreliable link has to survive.
   */
  dropConnectionsOn?: Record<string, number>;
}

/** The http-01 listener: it serves exactly what an ORDER registered. */
class ChallengeFiles implements ChallengeSink {
  readonly hits: string[] = [];
  base = "";
  private readonly tokens = new Map<string, string>();
  private server: http.Server | null = null;

  get openTokens(): number {
    return this.tokens.size;
  }

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      const path = (request.url ?? "").split("?")[0];
      this.hits.push(path);
      const token = /^\/\.well-known\/acme-challenge\/(.+)$/.exec(path)?.[1];
      const body = request.method === "GET" && token ? this.tokens.get(token) : undefined;
      if (body === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/plain" }).end(body);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const address = this.server?.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("the challenge listener did not bind");
    }
    this.base = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  register(token: string, keyAuthorization: string): void {
    this.tokens.set(token, keyAuthorization);
  }

  release(token: string): void {
    this.tokens.delete(token);
  }
}

class FakeAcme {
  readonly requests: RecordedRequest[] = [];
  /** The bytes fetched from the http-01 listener, or null when it 404'd. */
  fetchedChallenge: string | null = null;
  base = "";

  private server: http.Server | null = null;
  private nonceCounter = 0;
  private badNonceLeft: number;
  private rateLimitLeft: number;
  private challengeAnswered = false;
  private orderPolls = 0;
  private identifier: { type: string; value: string } | null = null;
  private readonly dropsLeft = new Map<string, number>();

  constructor(
    private readonly challengeBaseUrl: string,
    private readonly options: FakeOptions = {},
  ) {
    this.badNonceLeft = options.badNonceOnNewOrder ?? 0;
    this.rateLimitLeft = options.rateLimitOnNewOrder ?? 0;
    for (const [path, count] of Object.entries(options.dropConnectionsOn ?? {})) {
      this.dropsLeft.set(path, count);
    }
  }

  get directoryUrl(): string {
    return `${this.base}/directory`;
  }

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      void this.route(request, response);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const address = this.server?.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("the fake ACME server did not bind");
    }
    this.base = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The first request recorded for `path`, which must exist. */
  request(path: string): RecordedRequest {
    const found = this.requests.find((entry) => entry.path === path);
    if (!found) throw new Error(`the client never called ${path}`);
    return found;
  }

  requestCount(path: string): number {
    return this.requests.filter((entry) => entry.path === path).length;
  }

  // ── Routes ──

  private async route(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const path = (request.url ?? "").split("?")[0];

    if (request.method === "GET" && path === "/directory") {
      // No Replay-Nonce here on purpose: RFC 8555 §7.2 makes `newNonce` the way
      // to get one, so this is what forces the client down that path.
      const meta =
        this.options.profiles === null
          ? {}
          : { profiles: this.options.profiles ?? { shortlived: "shortlived" } };
      this.json(response, 200, {
        newNonce: `${this.base}/new-nonce`,
        newAccount: `${this.base}/new-account`,
        newOrder: `${this.base}/new-order`,
        meta,
      });
      return;
    }

    if (request.method === "HEAD" && path === "/new-nonce") {
      response.writeHead(200, { "Replay-Nonce": this.nonce() }).end();
      return;
    }

    if (request.method === "POST") {
      await this.post(path, await readBody(request), response);
      return;
    }

    this.json(response, 404, { detail: `no route for ${path}` }, false);
  }

  private async post(path: string, body: string, response: http.ServerResponse): Promise<void> {
    const recorded = recordRequest(path, body);
    this.requests.push(recorded);

    // A connection that dies before an answer. Nothing is written about the
    // request, which is the point: the client cannot tell whether the CA acted.
    const drops = this.dropsLeft.get(path);
    if (drops !== undefined && drops > 0) {
      this.dropsLeft.set(path, drops - 1);
      response.socket?.destroy();
      return;
    }

    if (path === "/new-order" && this.badNonceLeft > 0) {
      this.badNonceLeft--;
      this.json(
        response,
        400,
        { type: "urn:ietf:params:acme:error:badNonce", detail: "the nonce was already used" },
        false,
      );
      return;
    }
    if (path === "/new-order" && this.rateLimitLeft > 0) {
      this.rateLimitLeft--;
      this.json(
        response,
        429,
        { type: "urn:ietf:params:acme:error:rateLimited", detail: "too many orders" },
        true,
        { "Retry-After": this.options.rateLimitRetryAfter ?? "5" },
      );
      return;
    }

    switch (path) {
      case "/new-account":
        this.json(response, 201, { status: "valid" }, true, {
          Location: `${this.base}/acct/1`,
        });
        return;
      case "/new-order": {
        const payload = JSON.parse(recorded.payload) as {
          identifiers: { type: string; value: string }[];
        };
        this.identifier = payload.identifiers[0] ?? null;
        this.json(
          response,
          201,
          {
            status: "pending",
            identifiers: payload.identifiers,
            authorizations: [`${this.base}/authz/1`],
            finalize: `${this.base}/finalize/1`,
          },
          true,
          { Location: `${this.base}/order/1` },
        );
        return;
      }
      case "/authz/1":
        this.json(response, 200, this.authorization());
        return;
      case "/challenge/1":
        // The CA fetches the file while answering the POST, so a registration
        // that happens after it would be too late — exactly like the real one.
        this.fetchedChallenge = await this.fetchChallengeFile();
        this.challengeAnswered = true;
        this.json(response, 200, {
          type: "http-01",
          url: `${this.base}/challenge/1`,
          token: TOKEN,
          status: "processing",
        });
        return;
      case "/finalize/1":
        this.json(
          response,
          200,
          { status: "processing", finalize: `${this.base}/finalize/1` },
          true,
        );
        return;
      case "/order/1": {
        this.orderPolls++;
        if (this.orderPolls <= (this.options.orderProcessingPolls ?? 0)) {
          this.json(response, 200, { status: "processing" });
          return;
        }
        this.json(response, 200, {
          status: "valid",
          certificate: `${this.base}${CERTIFICATE_URL_PATH}`,
        });
        return;
      }
      case CERTIFICATE_URL_PATH:
        response
          .writeHead(200, {
            "Content-Type": "application/pem-certificate-chain",
            "Replay-Nonce": this.nonce(),
          })
          .end(FAKE_CHAIN);
        return;
      default:
        this.json(response, 404, { detail: `no route for ${path}` }, false);
    }
  }

  private authorization(): Record<string, unknown> {
    const failure = this.challengeAnswered ? this.options.authorizationFailure : undefined;
    return {
      identifier: this.identifier,
      status: failure ? "invalid" : this.challengeAnswered ? "valid" : "pending",
      challenges: [
        {
          type: "http-01",
          url: `${this.base}/challenge/1`,
          token: TOKEN,
          status: failure ? "invalid" : this.challengeAnswered ? "valid" : "pending",
          ...(failure
            ? {
                error: {
                  type: "urn:ietf:params:acme:error:unauthorized",
                  detail: failure,
                },
              }
            : {}),
        },
      ],
    };
  }

  private async fetchChallengeFile(): Promise<string | null> {
    const response = await fetch(`${this.challengeBaseUrl}/.well-known/acme-challenge/${TOKEN}`);
    if (!response.ok) return null;
    return await response.text();
  }

  private nonce(): string {
    this.nonceCounter++;
    return `nonce-${this.nonceCounter}`;
  }

  private json(
    response: http.ServerResponse,
    status: number,
    body: unknown,
    withNonce = true,
    headers: Record<string, string> = {},
  ): void {
    response
      .writeHead(status, {
        "Content-Type": "application/json",
        ...(withNonce ? { "Replay-Nonce": this.nonce() } : {}),
        ...headers,
      })
      .end(JSON.stringify(body));
  }
}

function recordRequest(path: string, body: string): RecordedRequest {
  const jws = JSON.parse(body) as { protected: string; payload: string; signature: string };
  return {
    path,
    header: JSON.parse(base64urlDecode(jws.protected).toString("utf8")) as Record<string, unknown>,
    protectedB64: jws.protected,
    payloadB64: jws.payload,
    payload: base64urlDecode(jws.payload).toString("utf8"),
    signature: base64urlDecode(jws.signature),
  };
}

/**
 * Verify a recorded ES256 signature with the account's public key. Asking for
 * `ieee-p1363` is deliberate: the JWS form is the raw 64-byte `r || s`, so a
 * DER signature (what `crypto.sign` returns by default) would not verify here.
 */
function verifiesWithAccountKey(jwk: Jwk, request: RecordedRequest): boolean {
  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  return crypto.verify(
    "sha256",
    Buffer.from(`${request.protectedB64}.${request.payloadB64}`, "ascii"),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    request.signature,
  );
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function accountKeyPem(): string {
  return crypto
    .generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
}

function thumbprintOf(accountPem: string): string {
  return jwkThumbprint(publicJwk(crypto.createPrivateKey(accountPem)));
}

function csrFor(identifier: { type: "ip" | "dns"; value: string }): Buffer {
  const privateKeyPem = accountKeyPem();
  return createCertificateRequest({
    privateKeyPem,
    ...(identifier.type === "ip" ? { ip: identifier.value } : { dns: identifier.value }),
  });
}

/** A client whose polls cost no time and back off no more than one tick. */
function testClient(fake: FakeAcme, accountPem: string, sleeps: number[] = []): AcmeClient {
  return new AcmeClient({
    directoryUrl: fake.directoryUrl,
    accountPrivateKeyPem: accountPem,
    contactEmail: "ops@example.com",
    pollIntervalMs: 1,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
}

let challengeFiles: ChallengeFiles;
const fakes: FakeAcme[] = [];

async function startFake(options: FakeOptions = {}): Promise<FakeAcme> {
  const fake = new FakeAcme(challengeFiles.base, options);
  await fake.start();
  fakes.push(fake);
  return fake;
}

beforeEach(async () => {
  challengeFiles = new ChallengeFiles();
  await challengeFiles.start();
});

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.stop()));
  await challengeFiles.stop();
});

describe("AcmeClient", () => {
  it("orders an IP certificate: jwk then kid, shortlived profile, http-01 file, PEM chain", async () => {
    const fake = await startFake();
    const accountPem = accountKeyPem();
    const accountJwk = publicJwk(crypto.createPrivateKey(accountPem));
    const identifier = { type: "ip", value: "127.0.0.1" } as const;
    const csr = csrFor(identifier);

    const chain = await testClient(fake, accountPem).obtainCertificate(
      { identifier, csrDer: csr },
      challengeFiles,
    );

    expect(chain).toBe(FAKE_CHAIN);

    // The account is created with the public JWK and no kid...
    const account = fake.request("/new-account");
    expect(account.header["jwk"]).toEqual(accountJwk);
    expect(account.header["kid"]).toBeUndefined();
    expect(JSON.parse(account.payload)).toEqual({
      termsOfServiceAgreed: true,
      contact: ["mailto:ops@example.com"],
    });
    // ...and the signature is the raw JOSE form over `protected.payload`.
    expect(account.signature).toHaveLength(64);
    expect(verifiesWithAccountKey(accountJwk, account)).toBe(true);

    // Every later request is addressed to the account URL from Location.
    for (const request of fake.requests) {
      if (request.path === "/new-account") continue;
      expect(request.header["kid"]).toBe(`${fake.base}/acct/1`);
      expect(request.header["jwk"]).toBeUndefined();
      expect(request.header["alg"]).toBe("ES256");
      expect(request.header["url"]).toBe(`${fake.base}${request.path}`);
    }

    // An IP order requests the short-lived profile and names one identifier.
    expect(JSON.parse(fake.request("/new-order").payload)).toEqual({
      identifiers: [{ type: "ip", value: "127.0.0.1" }],
      profile: "shortlived",
    });

    // The reads are POST-as-GET (empty payload), the challenge POST is `{}`.
    expect(fake.request("/authz/1").payload).toBe("");
    expect(fake.request("/challenge/1").payload).toBe("{}");
    expect(fake.request("/order/1").payload).toBe("");
    expect(fake.request(CERTIFICATE_URL_PATH).payload).toBe("");

    // finalize carries the caller's CSR DER, whose SAN is that one identifier.
    const finalized = JSON.parse(fake.request("/finalize/1").payload) as { csr: string };
    expect(base64urlDecode(finalized.csr)).toEqual(csr);
    expect(base64urlDecode(finalized.csr).includes(Buffer.from([127, 0, 0, 1]))).toBe(true);

    // The file the CA downloaded is the key authorization, byte for byte.
    expect(fake.fetchedChallenge).toBe(`${TOKEN}.${thumbprintOf(accountPem)}`);
    expect(fake.fetchedChallenge).not.toMatch(/\n$/);
    expect(challengeFiles.hits).toEqual([`/.well-known/acme-challenge/${TOKEN}`]);
    // The token was released once the authorization was decided.
    expect(challengeFiles.openTokens).toBe(0);
  });

  it("does not send a profile for a DNS identifier", async () => {
    const fake = await startFake();
    const accountPem = accountKeyPem();
    const identifier = { type: "dns", value: "vault.example.com" } as const;

    await testClient(fake, accountPem).obtainCertificate(
      { identifier, csrDer: csrFor(identifier) },
      challengeFiles,
    );

    const order = JSON.parse(fake.request("/new-order").payload) as Record<string, unknown>;
    expect(order["identifiers"]).toEqual([{ type: "dns", value: "vault.example.com" }]);
    expect(order["profile"]).toBeUndefined();
    expect(fake.fetchedChallenge).toBe(`${TOKEN}.${thumbprintOf(accountPem)}`);
  });

  it("refuses an IP order when the directory does not advertise shortlived", async () => {
    const fake = await startFake({ profiles: null });
    const accountPem = accountKeyPem();
    const identifier = { type: "ip", value: "127.0.0.1" } as const;

    await expect(
      testClient(fake, accountPem).obtainCertificate(
        { identifier, csrDer: csrFor(identifier) },
        challengeFiles,
      ),
    ).rejects.toThrow(/shortlived/);

    // Nothing was ordered, and no account was created either.
    expect(fake.requestCount("/new-order")).toBe(0);
    expect(fake.requestCount("/new-account")).toBe(0);
  });

  it("replays a badNonce answer with a fresh nonce", async () => {
    const fake = await startFake({ badNonceOnNewOrder: 1 });
    const accountPem = accountKeyPem();
    const identifier = { type: "ip", value: "127.0.0.1" } as const;

    const chain = await testClient(fake, accountPem).obtainCertificate(
      { identifier, csrDer: csrFor(identifier) },
      challengeFiles,
    );

    expect(chain).toBe(FAKE_CHAIN);
    const orders = fake.requests.filter((request) => request.path === "/new-order");
    expect(orders).toHaveLength(2);
    expect(orders[0].header["nonce"]).not.toBe(orders[1].header["nonce"]);
  });

  it("waits out Retry-After on a rate-limited request", async () => {
    const fake = await startFake({ rateLimitOnNewOrder: 1 });
    const accountPem = accountKeyPem();
    const identifier = { type: "ip", value: "127.0.0.1" } as const;
    const sleeps: number[] = [];

    await testClient(fake, accountPem, sleeps).obtainCertificate(
      { identifier, csrDer: csrFor(identifier) },
      challengeFiles,
    );

    // The fake answers `Retry-After: 5`, so the wait is five seconds — not the
    // one-millisecond backoff the poll interval would otherwise produce.
    expect(sleeps).toContain(5_000);
    expect(fake.requestCount("/new-order")).toBe(2);
  });

  it("reads an HTTP-date Retry-After against the client's clock", async () => {
    // RFC 9110 allows a date instead of seconds; the wait has to be measured
    // against the clock the order's budget runs on.
    const retryAt = new Date(Date.now() + 4_000).toUTCString();
    const fake = await startFake({ rateLimitOnNewOrder: 1, rateLimitRetryAfter: retryAt });
    const accountPem = accountKeyPem();
    const identifier = { type: "ip", value: "127.0.0.1" } as const;
    const sleeps: number[] = [];

    await testClient(fake, accountPem, sleeps).obtainCertificate(
      { identifier, csrDer: csrFor(identifier) },
      challengeFiles,
    );

    const waited = sleeps.find((ms) => ms >= 1_000);
    expect(waited).toBeDefined();
    expect(waited!).toBeGreaterThan(2_000);
    expect(waited!).toBeLessThanOrEqual(4_000);
    expect(fake.requestCount("/new-order")).toBe(2);
  });

  it("fails on a rate limit that outlasts the order", async () => {
    // A certificate limit says "retry after 2026-11-01 03:49:40 UTC", which is
    // hours away. Sleeping it out would turn it into "the order exceeded its
    // budget" — the one sentence that hides the real reason.
    const fake = await startFake({ rateLimitOnNewOrder: 1, rateLimitRetryAfter: "39724" });
    const accountPem = accountKeyPem();
    const identifier = { type: "ip", value: "127.0.0.1" } as const;
    const sleeps: number[] = [];

    await expect(
      testClient(fake, accountPem, sleeps).obtainCertificate(
        { identifier, csrDer: csrFor(identifier) },
        challengeFiles,
      ),
    ).rejects.toThrow(
      /rate limited this request \(retry after \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC\): too many orders/,
    );

    expect(sleeps).toEqual([]);
    expect(fake.requestCount("/new-order")).toBe(1);
  });

  it("still retries a rate limit with no Retry-After", async () => {
    // The header is what makes the limit "long": without one there is no time to
    // compare against the budget, and the request gets the ordinary backoff.
    const fake = await startFake({ rateLimitOnNewOrder: 1, rateLimitRetryAfter: "" });
    const accountPem = accountKeyPem();
    const identifier = { type: "ip", value: "127.0.0.1" } as const;
    const sleeps: number[] = [];

    await testClient(fake, accountPem, sleeps).obtainCertificate(
      { identifier, csrDer: csrFor(identifier) },
      challengeFiles,
    );

    expect(fake.requestCount("/new-order")).toBe(2);
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("polls the order while it is processing", async () => {
    const fake = await startFake({ orderProcessingPolls: 1 });
    const accountPem = accountKeyPem();
    const identifier = { type: "ip", value: "127.0.0.1" } as const;

    const chain = await testClient(fake, accountPem).obtainCertificate(
      { identifier, csrDer: csrFor(identifier) },
      challengeFiles,
    );

    expect(chain).toBe(FAKE_CHAIN);
    expect(fake.requestCount("/order/1")).toBe(2);
  });

  it("surfaces the challenge error detail when the authorization fails", async () => {
    const detail = "the http-01 challenge could not be fetched: connection refused";
    const fake = await startFake({ authorizationFailure: detail });
    const accountPem = accountKeyPem();
    const identifier = { type: "ip", value: "127.0.0.1" } as const;

    await expect(
      testClient(fake, accountPem).obtainCertificate(
        { identifier, csrDer: csrFor(identifier) },
        challengeFiles,
      ),
    ).rejects.toThrow(new RegExp(detail));

    // The failing path still releases the token.
    expect(challengeFiles.openTokens).toBe(0);
  });

  it("computes the RFC 7638 thumbprint of the published example", () => {
    // RFC 7638 §3.1: this canonical JWK hashes to the digest below.
    const jwk: Jwk = {
      kty: "RSA",
      e: "AQAB",
      n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
    };
    expect(jwkThumbprint(jwk)).toBe("NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs");
  });

  // A dropped connection is not an ACME answer, and reaching Let's Encrypt from
  // some networks produces exactly this: no problem document, just a dead socket.
  // Giving up on the first one means never getting a certificate.
  it("re-sends a request whose connection died, and finishes the order", async () => {
    const fake = await startFake({ dropConnectionsOn: { "/new-order": 1 } });
    const accountPem = accountKeyPem();
    const identifier = { type: "ip", value: "127.0.0.1" } as const;

    const chain = await testClient(fake, accountPem).obtainCertificate(
      { identifier, csrDer: csrFor(identifier) },
      challengeFiles,
    );

    expect(chain).toBe(FAKE_CHAIN);
    // Two: the one that died, and the one that was answered.
    expect(fake.requestCount("/new-order")).toBe(2);
    // The retry is a new request, so it carries a nonce of its own.
    const [first, second] = fake.requests.filter((entry) => entry.path === "/new-order");
    expect(second?.header["nonce"]).not.toBe(first?.header["nonce"]);
  });

  it("does not re-send finalize, where a lost answer is ambiguous", async () => {
    const fake = await startFake({ dropConnectionsOn: { "/finalize/1": 1 } });
    const accountPem = accountKeyPem();
    const identifier = { type: "ip", value: "127.0.0.1" } as const;

    const failure = await testClient(fake, accountPem)
      .obtainCertificate({ identifier, csrDer: csrFor(identifier) }, challengeFiles)
      .then(
        () => null,
        (error: Error) => error,
      );

    expect(failure?.message).toMatch(/finalize/);
    expect(fake.requestCount("/finalize/1")).toBe(1);
    // The failure still releases the challenge token.
    expect(challengeFiles.openTokens).toBe(0);

    // …and it says why: the transport hands back the socket's own error
    // (`socket hang up [ECONNRESET]`) rather than the `fetch failed` that every
    // undici failure is flattened into, which cannot tell a reset connection
    // from an unreachable directory.
    expect(failure?.message).toMatch(/socket hang up|ECONNRESET|EPIPE|aborted/i);
  });
});

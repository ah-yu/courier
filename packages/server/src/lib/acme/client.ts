import crypto from "crypto";
import http from "http";
import https from "https";
import { base64url, jwkThumbprint, publicJwk, signJws, type Jwk } from "./jws";

/**
 * A small ACME (RFC 8555) client — enough of the protocol to order and renew
 * one certificate for one identifier, with no dependency and no external
 * binary.
 *
 * Everything it sends is a signed JWS, so the two details that matter are the
 * nonce (every POST consumes one, and the server hands out the next in a
 * `Replay-Nonce` header) and the payload shape: a JSON body for `newAccount`,
 * `newOrder`, `challenge` and `finalize`, and the **empty octet string** for a
 * POST-as-GET (fetching an authorization, an order or the certificate).
 */

/** An ACME order identifier: an IP literal (RFC 8738) or a DNS name. */
export interface AcmeIdentifier {
  type: "ip" | "dns";
  value: string;
}

/**
 * Where the http-01 responses of an in-flight order live. ACME validates
 * http-01 by fetching `http://<identifier>/.well-known/acme-challenge/<token>`,
 * so the listener that serves those paths is fed from here for as long as the
 * challenge is being validated.
 */
export interface ChallengeSink {
  register(token: string, keyAuthorization: string): void;
  release(token: string): void;
}

/** What the certificate manager needs from a client; tests substitute this. */
export interface AcmeCertificateIssuer {
  obtainCertificate(
    request: { identifier: AcmeIdentifier; csrDer: Buffer },
    sink: ChallengeSink,
  ): Promise<string>;
}

/** The slice of `fetch` this client uses, so a test can hand in a fake. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AcmeClientOptions {
  directoryUrl: string;
  /** PKCS#8 PEM of the ACME account key (P-256). */
  accountPrivateKeyPem: string;
  /** Optional account contact, sent as `mailto:` unless already prefixed. */
  contactEmail?: string;
  /**
   * Transport override. The default is `requestOnce` below, not `fetch` — see
   * the note on it.
   */
  fetch?: FetchLike;
  /** Budget for one order, polling included. */
  timeoutMs?: number;
  /** First interval between polls; later polls back off from it. */
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  /** Sleep seam, so tests do not wait for real time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POLL_INTERVAL_MS = 10_000;
/** Replays allowed per request after a badNonce / rateLimited answer. */
const MAX_RETRIES = 3;
/** A single HTTP request never hangs longer than this, whatever the budget is. */
const REQUEST_TIMEOUT_MS = 30_000;

const ERROR_BAD_NONCE = "urn:ietf:params:acme:error:badNonce";
const ERROR_RATE_LIMITED = "urn:ietf:params:acme:error:rateLimited";

/**
 * Send one request on a connection of its own, and report what the socket says
 * when it fails.
 *
 * This is deliberately not `fetch`. undici keeps a connection pool, and a pooled
 * connection that something on the path has already closed fails a request that
 * a fresh one would have completed — which is exactly the difference between
 * this client and a `curl` that works. `agent: false` gives every request its
 * own socket, and a socket error arrives as itself (`socket hang up`,
 * `ECONNRESET`, `connect ETIMEDOUT acme-v02…:443`) instead of the `fetch failed`
 * every undici failure is flattened into.
 */
export async function requestOnce(input: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(input);
  const transport = target.protocol === "http:" ? http : https;

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
    if (value !== undefined) headers[key] = value;
  }
  const body = typeof init.body === "string" ? init.body : undefined;
  // Explicitly, because a body written without it would go out chunked.
  if (body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(body));

  return await new Promise<Response>((resolve, reject) => {
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port === "" ? undefined : target.port,
        path: `${target.pathname}${target.search}`,
        method: init.method ?? "GET",
        headers,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const received = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (typeof value === "string") received.set(key, value);
            else if (Array.isArray(value)) for (const item of value) received.append(key, item);
          }
          const status = response.statusCode ?? 500;
          // 204/205/304 are the statuses a body is not allowed with.
          const empty = status === 204 || status === 205 || status === 304 || chunks.length === 0;
          resolve(
            new Response(empty ? null : Buffer.concat(chunks), {
              status,
              statusText: response.statusMessage ?? "",
              headers: received,
            }),
          );
        });
      },
    );

    // The caller's deadline arrives as its signal; the socket follows it.
    const signal = init.signal;
    const abort = () => request.destroy(new Error("the request was aborted (its budget ran out)"));
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    request.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    if (body !== undefined) request.write(body);
    request.end();
  });
}

interface AcmeProblem {
  type?: string;
  detail?: string;
}

interface AcmeDirectory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
  meta?: { profiles?: Record<string, string> };
}

interface AcmeChallenge {
  type: string;
  url: string;
  token: string;
  status?: string;
  error?: AcmeProblem;
}

interface AcmeAuthorization {
  status: string;
  challenges?: AcmeChallenge[];
  error?: AcmeProblem;
}

interface AcmeOrder {
  status: string;
  authorizations?: string[];
  finalize?: string;
  certificate?: string;
  error?: AcmeProblem;
}

export class AcmeClient implements AcmeCertificateIssuer {
  private readonly options: AcmeClientOptions;
  private readonly fetchFn: FetchLike;
  private readonly key: crypto.KeyObject;
  private readonly jwk: Jwk;
  private readonly thumbprint: string;
  private readonly nowFn: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  private directory: AcmeDirectory | null = null;
  private kid: string | null = null;
  private nonce: string | null = null;

  constructor(options: AcmeClientOptions) {
    this.options = options;
    this.fetchFn = options.fetch ?? requestOnce;
    this.key = crypto.createPrivateKey(options.accountPrivateKeyPem);
    this.jwk = publicJwk(this.key);
    this.thumbprint = jwkThumbprint(this.jwk);
    this.nowFn = options.now ?? (() => Date.now());
    this.sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The http-01 response body for a token: `<token>.<thumbprint>` (RFC 8555 §8.1). */
  keyAuthorization(token: string): string {
    return `${token}.${this.thumbprint}`;
  }

  /**
   * Order a certificate for `identifier` and return the PEM chain (leaf first).
   *
   * The caller owns the certificate key and hands in the CSR, so this client
   * only ever needs the account key — and the SAN set is whatever the caller
   * put in that CSR, which must match the order's identifier exactly.
   */
  async obtainCertificate(
    request: { identifier: AcmeIdentifier; csrDer: Buffer },
    sink: ChallengeSink,
  ): Promise<string> {
    const deadline = this.nowFn() + this.timeout();
    const directory = await this.fetchDirectory(deadline);

    if (request.identifier.type === "ip") {
      // Let's Encrypt requires the shortlived profile for IP identifiers and
      // rejects an order without it. Checking the directory first turns that
      // into a sentence that names the cause instead of an opaque ACME error.
      const profiles = directory.meta?.profiles ?? {};
      if (!("shortlived" in profiles)) {
        throw new Error(
          `the ACME directory at ${this.options.directoryUrl} does not advertise the "shortlived" ` +
            `certificate profile, which is required for IP address certificates`,
        );
      }
    }

    await this.ensureAccount(directory, deadline);
    const { url: orderUrl, order } = await this.newOrder(directory, request.identifier, deadline);

    for (const authorizationUrl of order.authorizations ?? []) {
      await this.authorize(authorizationUrl, request.identifier, sink, deadline);
    }

    const certificateUrl = await this.finalize(order, orderUrl, request.csrDer, deadline);
    return this.downloadCertificate(certificateUrl, deadline);
  }

  // ── Steps ──

  private async fetchDirectory(deadline: number): Promise<AcmeDirectory> {
    if (this.directory) return this.directory;
    const response = await this.send(this.options.directoryUrl, { method: "GET" }, deadline);
    this.captureNonce(response);
    if (!response.ok) {
      throw new Error(
        `the ACME directory at ${this.options.directoryUrl} answered ${response.status}; ` +
          `check ACME_DIRECTORY_URL and that this machine can reach it`,
      );
    }
    const directory = await readJson<AcmeDirectory>(response, this.options.directoryUrl);
    for (const endpoint of ["newNonce", "newAccount", "newOrder"] as const) {
      if (!directory[endpoint]) {
        throw new Error(
          `the ACME directory at ${this.options.directoryUrl} has no "${endpoint}" endpoint`,
        );
      }
    }
    this.directory = directory;
    return directory;
  }

  private async ensureAccount(directory: AcmeDirectory, deadline: number): Promise<void> {
    if (this.kid) return;
    const payload: Record<string, unknown> = { termsOfServiceAgreed: true };
    const email = this.options.contactEmail?.trim();
    if (email) {
      payload["contact"] = [email.startsWith("mailto:") ? email : `mailto:${email}`];
    }
    // The account does not exist yet, so this is the one request signed with the
    // `jwk` header instead of a `kid`.
    const response = await this.signedPost(
      directory.newAccount,
      JSON.stringify(payload),
      deadline,
      {
        useJwk: true,
        accept: "application/json",
      },
    );
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("the ACME server registered an account without a Location header");
    }
    this.kid = location;
  }

  private async newOrder(
    directory: AcmeDirectory,
    identifier: AcmeIdentifier,
    deadline: number,
  ): Promise<{ url: string; order: AcmeOrder }> {
    const payload: Record<string, unknown> = {
      identifiers: [{ type: identifier.type, value: identifier.value }],
    };
    // The `profile` field comes from the ACME profiles draft, and IP
    // certificates must use the short-lived one at Let's Encrypt. A DNS order
    // must not send a profile at all.
    if (identifier.type === "ip") payload["profile"] = "shortlived";

    const response = await this.signedPost(directory.newOrder, JSON.stringify(payload), deadline, {
      accept: "application/json",
    });
    const order = await readJson<AcmeOrder>(response, directory.newOrder);
    const url = response.headers.get("location");
    if (!url) throw new Error("the ACME server created an order without a Location header");
    return { url, order };
  }

  /** Answer one authorization's http-01 challenge and wait for the decision. */
  private async authorize(
    authorizationUrl: string,
    identifier: AcmeIdentifier,
    sink: ChallengeSink,
    deadline: number,
  ): Promise<void> {
    let authorization = await this.postAsGet<AcmeAuthorization>(authorizationUrl, deadline);
    if (authorization.status === "valid") return;

    const challenge = authorization.challenges?.find((entry) => entry.type === "http-01");
    if (!challenge) {
      throw new Error(`the ACME authorization for ${identifier.value} offers no http-01 challenge`);
    }

    // Registering before the POST matters: the server validates the challenge as
    // soon as it accepts the response, so the file has to be servable first.
    const keyAuthorization = this.keyAuthorization(challenge.token);
    sink.register(challenge.token, keyAuthorization);
    try {
      // The challenge response body is `{}` — the key authorization is already
      // reachable over http-01; this POST only says "go and check it".
      await this.postJson(challenge.url, {}, deadline);

      let attempt = 0;
      for (;;) {
        authorization = await this.postAsGet<AcmeAuthorization>(authorizationUrl, deadline);
        if (authorization.status === "valid") return;
        if (authorization.status === "invalid") {
          throw this.authorizationError(authorization, identifier);
        }
        await this.pollWait(attempt++, deadline);
      }
    } finally {
      sink.release(challenge.token);
    }
  }

  /** Finalize with the CSR and poll the order until it carries a certificate. */
  private async finalize(
    order: AcmeOrder,
    orderUrl: string,
    csrDer: Buffer,
    deadline: number,
  ): Promise<string> {
    if (!order.finalize) throw new Error("the ACME order has no finalize URL");
    // No network retry here: a finalize whose answer was lost may well have been
    // finalized, and the order is the thing that says so. Re-sending could as
    // easily produce `orderNotReady` and hide the order that exists; the caller's
    // next attempt starts a fresh order instead.
    await this.postJson(order.finalize, { csr: base64url(csrDer) }, deadline, {
      retryNetwork: false,
    });

    // finalize answers with the order, but issuance is asynchronous: the order
    // moves processing → valid, and only then is `certificate` usable.
    let attempt = 0;
    for (;;) {
      const current = await this.postAsGet<AcmeOrder>(orderUrl, deadline);
      if (current.status === "valid") {
        if (!current.certificate) {
          throw new Error("the ACME order is valid but carries no certificate URL");
        }
        return current.certificate;
      }
      if (current.status === "invalid") throw this.orderError(current);
      await this.pollWait(attempt++, deadline);
    }
  }

  private async downloadCertificate(certificateUrl: string, deadline: number): Promise<string> {
    const response = await this.signedPost(certificateUrl, "", deadline, {
      accept: "application/pem-certificate-chain",
    });
    const pem = await response.text();
    if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
      throw new Error("the ACME certificate response is not a PEM chain");
    }
    return pem;
  }

  // ── Signed requests ──

  /**
   * POST one JWS-signed request.
   *
   * Two different failures are retried, because both are expected of a real
   * client: a `badNonce` or a rate limit (RFC 8555 §6.5 — a nonce can expire
   * between two requests), and a connection that died before answering (a
   * request the network dropped is not an ACME answer, and nothing was decided).
   */
  private async signedPost(
    url: string,
    payload: string,
    deadline: number,
    options: { useJwk?: boolean; accept?: string; retryNetwork?: boolean } = {},
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        const nonce = await this.takeNonce(deadline);
        const header: Record<string, unknown> = { alg: "ES256", url, nonce };
        if (options.useJwk) header["jwk"] = this.jwk;
        else header["kid"] = this.requireKid();

        const jws = signJws({ privateKey: this.key, payload, header });
        response = await this.send(
          url,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/jose+json",
              ...(options.accept ? { Accept: options.accept } : {}),
            },
            body: JSON.stringify(jws),
          },
          deadline,
        );
      } catch (error) {
        // A connection that died is not an answer: nothing was decided, so the
        // request goes out again with a fresh nonce. A dropped request is what
        // reaching Let's Encrypt from some networks looks like — it is not an
        // ACME error, so the retry below never sees it, and without this one
        // reset costs the whole issuance.
        //
        // `finalize` opts out: there a lost answer is ambiguous (the order may
        // well have been finalized), and re-sending it is not obviously safe.
        if (options.retryNetwork === false || attempt >= MAX_RETRIES || this.nowFn() >= deadline) {
          throw error;
        }
        await this.waitBeforeNetworkRetry(attempt, deadline);
        continue;
      }
      this.captureNonce(response);
      if (response.ok) return response;

      const problem = await readProblem(response);
      if (isRetryable(problem, response.status) && attempt < MAX_RETRIES) {
        await this.waitBeforeRetry(response, attempt, deadline);
        continue;
      }
      throw new Error(
        `the ACME request to ${url} failed with ${response.status}: ${problemText(problem)}`,
      );
    }
  }

  private async postJson<T>(
    url: string,
    payload: unknown,
    deadline: number,
    options?: { useJwk?: boolean; accept?: string; retryNetwork?: boolean },
  ): Promise<T> {
    const response = await this.signedPost(url, JSON.stringify(payload), deadline, options);
    return await readJson<T>(response, url);
  }

  /** POST-as-GET: the authenticated read of an authorization, order or cert. */
  private async postAsGet<T>(url: string, deadline: number): Promise<T> {
    const response = await this.signedPost(url, "", deadline, { accept: "application/json" });
    return await readJson<T>(response, url);
  }

  /**
   * Take the next nonce: the one the server sent with its last response, or a
   * fresh HEAD to `newNonce` when there is none.
   */
  private async takeNonce(deadline: number): Promise<string> {
    if (this.nonce) {
      const nonce = this.nonce;
      this.nonce = null;
      return nonce;
    }
    const directory = this.directory;
    if (!directory) throw new Error("the ACME directory has not been fetched yet");
    // newNonce is a HEAD with no body and no JWS at all (RFC 8555 §7.2).
    const response = await this.send(directory.newNonce, { method: "HEAD" }, deadline);
    const nonce = response.headers.get("replay-nonce");
    if (!nonce) {
      throw new Error("the ACME server's newNonce response carried no Replay-Nonce header");
    }
    return nonce;
  }

  private captureNonce(response: Response): void {
    const nonce = response.headers.get("replay-nonce");
    if (nonce) this.nonce = nonce;
  }

  private requireKid(): string {
    if (!this.kid) throw new Error("the ACME account has not been registered yet");
    return this.kid;
  }

  private async send(url: string, init: RequestInit, deadline: number): Promise<Response> {
    const remaining = deadline - this.nowFn();
    if (remaining <= 0) throw new Error(`the ACME order exceeded its ${this.timeout()}ms budget`);
    try {
      return await this.fetchFn(url, {
        ...init,
        signal: AbortSignal.timeout(Math.max(1, Math.min(remaining, REQUEST_TIMEOUT_MS))),
      });
    } catch (error) {
      // Keep the original error as the cause: it is what carries the socket-level
      // detail (`ECONNREFUSED`, `ENOTFOUND`, a TLS alert).
      throw new Error(`the ACME request to ${url} failed: ${errorText(error)}`, { cause: error });
    }
  }

  /** Sleep before the next poll, backing off, but never past the budget. */
  private async pollWait(attempt: number, deadline: number): Promise<void> {
    const interval = Math.min(
      this.pollInterval() * 1.5 ** attempt,
      this.options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS,
    );
    const remaining = deadline - this.nowFn();
    if (remaining <= 0) {
      throw new Error(`the ACME order did not finish within ${this.timeout()}ms`);
    }
    await this.sleepFn(Math.min(interval, remaining));
  }

  /** Honour `Retry-After` when it is cheap, otherwise back off exponentially. */
  private async waitBeforeRetry(
    response: Response,
    attempt: number,
    deadline: number,
  ): Promise<void> {
    let delay = Math.min(
      this.pollInterval() * 2 ** attempt,
      this.options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS,
    );
    const header = response.headers.get("retry-after");
    if (header) {
      const seconds = Number(header);
      const requested = Number.isFinite(seconds)
        ? seconds * 1_000
        : Date.parse(header) - this.nowFn();
      if (Number.isFinite(requested) && requested >= 0) delay = Math.max(delay, requested);
    }
    const remaining = deadline - this.nowFn();
    if (remaining <= 0) {
      throw new Error(
        `the ACME server rate limited this request and the ${this.timeout()}ms budget is spent`,
      );
    }
    await this.sleepFn(Math.min(delay, remaining));
  }

  /**
   * Back off before re-sending a request whose connection died. Short on
   * purpose: nothing on the server side is waiting for this one, and the point
   * is to get past a reset connection rather than to be polite about it.
   */
  private async waitBeforeNetworkRetry(attempt: number, deadline: number): Promise<void> {
    const delay = Math.min(
      this.pollInterval() * 2 ** attempt,
      this.options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS,
    );
    const remaining = deadline - this.nowFn();
    if (remaining <= 0) {
      throw new Error(`the ACME order exceeded its ${this.timeout()}ms budget`);
    }
    await this.sleepFn(Math.min(delay, remaining));
  }

  // ── Errors ──

  private authorizationError(authorization: AcmeAuthorization, identifier: AcmeIdentifier): Error {
    // The per-challenge error carries the useful text (a failed http-01 says
    // which URL it fetched, or which status it saw).
    const details = (authorization.challenges ?? [])
      .map((challenge) => challenge.error?.detail ?? challenge.error?.type)
      .filter((detail): detail is string => Boolean(detail));
    const detail = details[0] ?? authorization.error?.detail ?? authorization.error?.type;
    return new Error(
      `the ACME authorization for ${identifier.type} ${identifier.value} failed: ` +
        `${detail ?? "the server reported no detail"}`,
    );
  }

  private orderError(order: AcmeOrder): Error {
    const detail = order.error?.detail ?? order.error?.type;
    return new Error(`the ACME order failed: ${detail ?? "the server reported no detail"}`);
  }

  private timeout(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private pollInterval(): number {
    return this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }
}

/** Retry only what the protocol says is worth retrying. */
function isRetryable(problem: AcmeProblem, status: number): boolean {
  return (
    problem.type === ERROR_BAD_NONCE ||
    problem.type === ERROR_RATE_LIMITED ||
    status === 429 ||
    status === 503
  );
}

async function readJson<T>(response: Response, url: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`the ACME server answered ${url} with a body that is not JSON`);
  }
}

/**
 * Read an error body. An ACME error is a `application/problem+json` document,
 * but a proxy can answer with HTML and an empty 503 has nothing at all, so the
 * raw text is kept as the detail in that case.
 */
async function readProblem(response: Response): Promise<AcmeProblem> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed as AcmeProblem;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  const detail = text.trim().slice(0, 200);
  return detail ? { detail } : {};
}

function problemText(problem: AcmeProblem): string {
  return problem.detail ?? problem.type ?? "the server reported no problem document";
}

/**
 * One line for a failed request. The useful part of a rejected `fetch` is its
 * `cause` — `ECONNREFUSED`, `ENOTFOUND`, `other side closed`, a TLS error — while
 * the `TypeError` itself only ever says "fetch failed", which cannot tell an
 * unreachable directory from a blocked port 80.
 *
 * The whole chain is walked, not just the first cause: `fetch` wraps its own
 * failures more than once (`fetch failed` → `fetch failed` → `other side
 * closed`), so reading one link can still leave the reason out. A `code`
 * (`UND_ERR_SOCKET`, `ECONNRESET`, `UND_ERR_CONNECT_TIMEOUT`) is appended when
 * the message does not already carry it.
 */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    const message = current instanceof Error ? current.message : String(current);
    const code = (current as { code?: unknown }).code;
    const text =
      typeof code === "string" && code !== "" && !message.includes(code)
        ? `${message} [${code}]`
        : message;
    if (text !== "" && !parts.includes(text)) parts.push(text);
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(" / ") || "an unknown error";
}

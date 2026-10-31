/**
 * What a client does when the server's rate limiter says "not now".
 *
 * The sync routes are request-limited per vault (see `packages/server/src/middleware/
 * rate-limit.ts`), and a first bind is by far the largest burst a client ever sends.
 * A refusal used to end the whole pass — the host then retried five minutes later —
 * even though the server states how long the window has left. These helpers let the
 * engine wait that long and carry on with the same batch.
 *
 * The check is duck-typed rather than `instanceof ApiClientError`: a host may inject
 * any `SyncApi`, and the one thing that matters is the answer the server gave, not
 * which class carries it. `status === 429` is the HTTP fact; `code` covers a host
 * that re-wraps the error.
 */

/** How long to wait when the server refused without saying for how long. */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 61_000;

/** Upper bound on one wait, whatever the server claims. */
export const MAX_RATE_LIMIT_WAIT_MS = 5 * 60_000;

/** How many times one request may wait out a window before its failure is final. */
export const MAX_RATE_LIMIT_WAITS = 3;

/** True when `err` is a rate-limit refusal (HTTP 429 / `RATE_LIMITED`). */
export function isRateLimitError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as { status?: unknown; code?: unknown };
  return candidate.status === 429 || candidate.code === "RATE_LIMITED";
}

/**
 * How long to wait before retrying a refused request.
 *
 * A `Retry-After` the server sent (already converted to milliseconds by the shared
 * HTTP client) is used as-is within bounds; without one, a full window is the only
 * safe guess, because a shorter wait would be refused again and burn an attempt.
 */
export function rateLimitWaitMs(err: unknown): number {
  const asked =
    typeof err === "object" && err !== null
      ? (err as { retryAfterMs?: unknown }).retryAfterMs
      : undefined;
  if (typeof asked === "number" && Number.isFinite(asked) && asked > 0) {
    return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(50, Math.ceil(asked)));
  }
  return DEFAULT_RATE_LIMIT_WAIT_MS;
}

/** Resolve after `ms`, for a pass that has to wait out a limiter window. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

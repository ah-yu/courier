import type { LogLevel } from "../lib/logger";

/**
 * One line per HTTP request.
 *
 * The level is the filter, so `LOG_LEVEL` decides what the log is for:
 *
 *   - `debug` — every successful read (including the health/runtime/status
 *     polls), every successful sync push, and every request **no route answered**.
 *     The deployed port listens on the public internet and is scanned
 *     continuously (`GET /`, `GET /.git/HEAD`, `GET /mcp`, `POST /sdk`), so those
 *     paths are somebody else's traffic: they stay in the full access log a
 *     deployment turns on with `LOG_LEVEL=debug`, and out of the default view.
 *   - `info` — a 4xx **a route produced** (an unknown vault or version, a bad
 *     body), and a **successful mutation** (creating an account, deleting one,
 *     emptying the recycle bin): worth a record, not worth an alarm.
 *   - `warn` — a **rejected credential** (a 401/403 whose request carried an
 *     `Authorization` header), or a request that took `slowMs` or more. A rejected
 *     key is the one client error that means something is wrong on this side of
 *     the wire — an operator's own key expired, a device is using an old key — so
 *     it belongs in the warning-and-above view.
 *   - `error` — a 5xx, the only kind of request this service itself failed.
 *
 * Two facts decide the classification beyond the status. `routeMiss` says the
 * framework answered 404 because nothing matched: a path this service does not
 * serve is not a refusal of a client, so it is `debug` even when the probe was
 * slow. `hasAuthorization` says a credential was presented: a 401/403 without one
 * is a probe of a protected path, not a rejected key, so it is `debug` too —
 * unless the request was slow, where the latency warning wins.
 *
 * **A mutation is audited even when it succeeds.** "I deleted a key" has to leave a
 * line at the default level, or the log answers every question except the one an
 * operator asks after changing something. The sync push is the exception: it is the
 * one mutation that happens all day, and its refusals are logged by the route.
 *
 * **A poll is an ordinary read.** A `200` from `/api/health`, `/api/admin/runtime`
 * or `/api/admin/status` is `debug` like any other success, so the default view
 * does not carry a monitoring client's timer; `LOG_LEVEL=debug` shows it at that rate.
 *
 * A sync refusal is **not** a failed request either: `POST …/sync/push` answers
 * `200` with per-file `stale_base` / `content_missing` results, so the push route
 * logs those itself (one line naming the counts). Reading `c.res.status` alone
 * would report every one of them as a healthy 200.
 *
 * Nothing here reads the body. The service is content-blind by design, and an
 * access log is the last place to start recording what a client sent.
 */

/** The one mutation that is data traffic rather than an administrative act. */
const SYNC_PUSH = /\/sync\/push$/;

/** Whether a method changes stored state. */
function isMutation(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

/** Everything the level is decided from, so a test can pin one fact at a time. */
export interface RequestFacts {
  method: string;
  path: string;
  status: number;
  ms: number;
  slowMs: number;
  /** No route answered: a scan or a typo, not this service refusing a client. */
  routeMiss: boolean;
  /** The request carried an `Authorization` header, so a 401/403 is a rejection. */
  hasAuthorization: boolean;
}

/** The level a finished request is worth. */
export function requestLevel(facts: RequestFacts): LogLevel {
  const { method, path, status, ms, slowMs, routeMiss, hasAuthorization } = facts;
  if (status >= 500) return "error";
  // A path this service does not serve is not its traffic, however slow the probe.
  if (routeMiss) return "debug";
  if (ms >= slowMs) return "warn";
  // A credential that was presented and refused is the one client error worth a
  // warning; one that was never presented is a probe of a protected path.
  if (status === 401 || status === 403) return hasAuthorization ? "warn" : "debug";
  if (status >= 400) return "info";
  // A successful mutation is an auditable act, not traffic.
  if (isMutation(method) && !SYNC_PUSH.test(path)) return "info";
  return "debug";
}

/** The record text: what was asked, what came back, how long it took. */
export function requestMessage(method: string, path: string, status: number, ms: number): string {
  return `${method} ${path} ${status} ${ms}ms`;
}

import type { SyncPushResult } from "@courier/shared";
import type { Logger } from "./logger";

/**
 * Log the per-file results a push batch did not accept.
 *
 * A refusal is a `200` with `stale_base` / `content_missing` in the body, so the
 * access log sees a healthy request and the reason never reaches the server's log
 * at all — which is the one thing an operator chasing "this note will not sync"
 * needs. `stale_base` is routine under concurrency (the client pulls and decides
 * again), so it stays at `info`; a missing blob or a handler error is a `warn`,
 * because neither resolves itself.
 *
 * The line carries the counts, not the file ids: a 100-file push that refused one
 * version is one line, and the ids are the client's own record. No content, no
 * path — the server never has either.
 */
export function logPushResults(
  logger: Logger,
  vaultId: string,
  deviceName: string | null,
  results: SyncPushResult[],
): void {
  const refused = results.filter((result) => result.status !== "ok");
  if (refused.length === 0) return;

  const counts = new Map<string, number>();
  for (const result of refused) {
    counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
  }
  const detail = [...counts].map(([status, count]) => `${status}=${count}`).join(" ");
  const firstError = refused.find((result) => result.error)?.error;
  const line =
    `push ${vaultId}: ${refused.length}/${results.length} refused ${detail}` +
    ` device=${deviceName ?? "unknown"}` +
    (firstError ? ` error="${firstError}"` : "");

  if (counts.has("content_missing") || counts.has("error")) logger.warn(line);
  else logger.info(line);
}

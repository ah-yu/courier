import { appendFileSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { SyncActivityEvent } from "@courier/engine";
import { configDir } from "./config";

/**
 * The daemon's own sync log, on disk.
 *
 * The plugin keeps its run's events in memory (`shared/sync-log.ts`); the CLI is a separate
 * process, so a supervisor can only read them if they are written down. One JSON line per
 * event under the CLI's config directory, cleared when a daemon starts: the file describes
 * **this run**, exactly like the plugin's dialog, and a restart starts a new one.
 *
 * The vault id is hashed for the file name for the same reason the state file hashes it:
 * an id comes from the server and must not escape this directory.
 */

/** One recorded event: the engine's answer, plus when this process recorded it. */
export type RunHistoryEntry = SyncActivityEvent & { at: string };

/** How large the file may grow before the oldest lines are dropped. */
const MAX_BYTES = 2 * 1024 * 1024;
/** How many recent lines a rotation keeps. */
const KEEP_LINES = 500;
/**
 * How many event identities one run remembers, so a pass that re-reports the same decision
 * (a reconcile, a skip that fires again) does not repeat its row.
 *
 * The same shape the plugin's in-memory log uses: bounded separately from the file, so a
 * first bind of a large vault does not grow it without limit.
 */
const RECORDED_LIMIT = KEEP_LINES * 4;

/** Per-vault identities already written in this process. */
const recorded = new Map<string, Set<string>>();

/**
 * The identity of one event, for de-duplication.
 *
 * A version identifies a sent or applied change by itself; `direction` and `outcome`
 * guard the impossible shape where the same version were both. The reason is not part of
 * a versioned key (the first decision is the one recorded), while a versionless skip uses
 * its path, reason and size, so a file that grew past the cap is a new event.
 */
function eventKey(event: SyncActivityEvent): string {
  if (event.versionId !== null) {
    return `${event.direction}:${event.fileId ?? ""}:${event.versionId}:${event.outcome}`;
  }
  return `${event.direction}:${event.outcome}:${event.plainPath}:${
    event.outcome === "skipped" ? event.reason : ""
  }:${event.sizeBytes}`;
}

/** Where one vault's run history lives. */
export function activityLogPath(vaultId: string): string {
  const digest = new Bun.CryptoHasher("sha256").update(vaultId).digest("hex").slice(0, 24);
  return join(configDir(), "history", `${digest}.jsonl`);
}

/** Start a new run's history: the previous daemon's events are not this run's. */
export function clearActivityLog(vaultId: string): void {
  recorded.delete(vaultId);
  try {
    unlinkSync(activityLogPath(vaultId));
  } catch {
    // Already absent.
  }
}

/**
 * Append one engine decision, unless this run already recorded the same one. A write
 * failure is swallowed on purpose: the history is a convenience for a supervisor, and it
 * must never fail the sync that reported it.
 */
export function recordRunActivity(vaultId: string, event: SyncActivityEvent): void {
  let seen = recorded.get(vaultId);
  if (!seen) {
    seen = new Set<string>();
    recorded.set(vaultId, seen);
  }
  const key = eventKey(event);
  if (seen.has(key)) return;
  seen.add(key);
  // Insertion order is the order to drop: the oldest identity goes first.
  if (seen.size > RECORDED_LIMIT) {
    for (const oldest of seen) {
      seen.delete(oldest);
      if (seen.size <= RECORDED_LIMIT) break;
    }
  }
  try {
    const file = activityLogPath(vaultId);
    mkdirSync(join(configDir(), "history"), { recursive: true });
    rotateIfNeeded(file);
    appendFileSync(
      file,
      `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`,
      "utf-8",
    );
  } catch {
    // The sync itself succeeded; a missing history row is not worth failing it.
  }
}

/** Keep the file bounded: a long-running daemon keeps only its recent events. */
function rotateIfNeeded(file: string): void {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return; // Missing: the first line creates it.
  }
  if (size <= MAX_BYTES) return;
  try {
    const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
    writeFileSync(file, `${lines.slice(-KEEP_LINES).join("\n")}\n`, "utf-8");
  } catch {
    // A rotation that fails leaves the file as it was; the append still lands.
  }
}

import type { SyncActivityEvent } from "@courier/engine";
import { reversedCopy } from "@courier/shared";

/**
 * How many events one plugin run keeps in memory.
 *
 * A session that binds a large vault reaches this quickly (one event per applied file),
 * and the dialog is a scrolling list of rows, so the buffer is the recent end of the run
 * and the header says how much of it is shown. The old 200-row display limit came from
 * the whole-vault history; a run's own log is cheaper, but the DOM it paints is what the
 * cap really bounds.
 */
export const SYNC_LOG_LIMIT = 500;

/**
 * One sync event from this plugin run, as the history dialog shows it.
 *
 * `at` is when this device recorded the event, not the version's `createdAt`: the log is
 * this device's activity, and an event discovered by a reconcile can describe a version
 * pushed minutes ago. The event itself (direction, outcome and — for a skip — the reason)
 * is the engine's answer at the moment it decided, frozen here. Nothing recomputes it from
 * the current settings or the current device name.
 */
export type SyncLogEntry = SyncActivityEvent & { at: string };

/** The two containers the dialog paints: the recent rows and the run's total. */
export interface SyncLogSnapshot {
  /** The recent events, newest first. */
  entries: readonly SyncLogEntry[];
  /** Every event this run recorded, including ones evicted from `entries`. */
  total: number;
}

/**
 * The plugin run's sync events, in memory.
 *
 * There is deliberately no persistence: the dialog is a log of **this run**, so a plugin
 * reload starts empty (and `main.ts` clears it on unbind and unload). The server's
 * version chains are still the durable history — the per-file version dialog and the
 * recycle bin read those — but they cannot say whether *this* device applied a change,
 * which is the question this log answers.
 *
 * Module-level rather than a field of the plugin or the engine host: the host is rebuilt
 * whenever a scope switch changes (the engine reads the scope when it is constructed),
 * and the log of what happened before that restart is still this run's history.
 */
let entries: SyncLogEntry[] = [];
let total = 0;
/**
 * Events already recorded, so a pass that re-reports a skipped chain does not repeat it.
 *
 * Bounded separately from the rows: a first bind of a large vault reports one event per
 * file, and an unbounded set would keep every one of them for the whole session. When the
 * oldest keys are dropped, a skip older than the buffer can appear again on a later
 * pass; that is the price of a bounded in-memory feed, and such a row is already outside
 * the 500-row window anyway.
 */
const recorded = new Set<string>();
const RECORDED_KEYS_LIMIT = SYNC_LOG_LIMIT * 4;
const listeners = new Set<() => void>();

/**
 * The identity of one event, for de-duplication.
 *
 * A version identifies a sent or applied change by itself; `direction` and `outcome`
 * guard the impossible shape where the same version were both. The reason is deliberately
 * **not** part of a versioned key: the first decision about a version is the one the log
 * records, so a later pass that would name a different switch cannot rewrite the row. A
 * skip with no version (a local file over the size cap, a path too long for the API) has
 * no id to lean on, so its path, reason and size are the identity: the same file skipped
 * again without changing is the same event, while a file that grew past the cap is new.
 */
function eventKey(event: SyncActivityEvent): string {
  if (event.versionId !== null) {
    return `${event.direction}:${event.fileId ?? ""}:${event.versionId}:${event.outcome}`;
  }
  return `${event.direction}:${event.outcome}:${event.plainPath}:${
    event.outcome === "skipped" ? event.reason : ""
  }:${event.sizeBytes}`;
}

/** Add one event. A duplicate (same version, or same versionless skip) is ignored. */
export function recordSyncActivity(event: SyncActivityEvent): void {
  const key = eventKey(event);
  if (recorded.has(key)) return;
  recorded.add(key);
  // Sets iterate in insertion order, so this drops the oldest keys first.
  if (recorded.size > RECORDED_KEYS_LIMIT) {
    for (const oldest of recorded) {
      recorded.delete(oldest);
      if (recorded.size <= RECORDED_KEYS_LIMIT) break;
    }
  }
  entries.push({ ...event, at: new Date().toISOString() });
  total += 1;
  if (entries.length > SYNC_LOG_LIMIT) entries = entries.slice(entries.length - SYNC_LOG_LIMIT);
  notify();
}

/** The current rows (newest first) and the run's total. */
export function getSyncLog(): SyncLogSnapshot {
  return { entries: reversedCopy(entries), total };
}

/**
 * Subscribe to a new event or a clear. The returned function unsubscribes.
 *
 * A dialog outliving one render must unsubscribe on close; the store's listeners are
 * module-level, so a leak keeps repainting a dialog that is gone.
 */
export function onSyncLogChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Forget the run's events (bind/unbind, logout, unload). */
export function clearSyncLog(): void {
  entries = [];
  total = 0;
  recorded.clear();
  notify();
}

/** Test driver: drop the events and every listener, so one test cannot leak into the next. */
export function resetSyncLogForTests(): void {
  entries = [];
  total = 0;
  recorded.clear();
  listeners.clear();
}

function notify(): void {
  // Iterated as-is: a listener that unsubscribes itself during the report is simply not
  // called again, which is what "unsubscribed" means.
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      // A surface that fails to repaint must not fail the sync that reported it.
      console.error("Courier: a sync-log listener failed:", err);
    }
  }
}

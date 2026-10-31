import type { SyncAction } from "@courier/shared";
import type { SyncActivitySkipReason } from "@courier/engine";
import { getLocale, plural, t, type PluginMessageKey } from "../i18n";
import type { SyncLogEntry } from "./sync-log";

/** The catalog key of each sync action. */
const SYNC_ACTION_KEYS: Record<SyncAction, PluginMessageKey> = {
  create: "history.action.create",
  modify: "history.action.modify",
  rename: "history.action.rename",
  delete: "history.action.delete",
  restore: "history.action.restore",
};

/**
 * How each sync action reads in the UI. One function, shared by the
 * version-history view, the recycle bin and the session log — the e2e suite asserts
 * these exact words. It reads the locale at call time, so the bundle loading before
 * `onload` cannot freeze the labels.
 */
export function syncActionLabel(action: SyncAction): string {
  return t(SYNC_ACTION_KEYS[action]);
}

/** Zero-pad a clock field to two digits — the shape every date and time below uses. */
function padTwo(value: number): string {
  return String(value).padStart(2, "0");
}

/** A run of items that share one local calendar day, in the order they were given. */
export interface LocalDayGroup<T> {
  /** The `at` of the group's first item — what the day header is formatted from. */
  at: string;
  items: T[];
}

/**
 * Split an already-ordered stream into days, in that same order.
 *
 * The input is ordered by its caller (the log newest first, a version chain newest
 * first), so this only compares each item's local calendar day with the one before it —
 * no sorting, and the day boundaries are the reader's own timezone, which is the only
 * clock a log or a version list makes sense in.
 *
 * Two surfaces group by day this way: the sync log (`groupSyncHistoryByDay`) and the
 * version history (`groupVersionsByDay`). Only the item type and its timestamp differ.
 */
export function groupByLocalDay<T>(
  items: readonly T[],
  at: (item: T) => string,
): LocalDayGroup<T>[] {
  const days: LocalDayGroup<T>[] = [];
  for (const item of items) {
    const last = days.at(-1);
    if (last && localDayKey(last.at) === localDayKey(at(item))) last.items.push(item);
    else days.push({ at: at(item), items: [item] });
  }
  return days;
}

/** One day of the log: the events that happened on it, newest first. */
export interface SyncHistoryDay {
  /** `at` of the day's newest event — what the day header is formatted from. */
  at: string;
  entries: SyncLogEntry[];
}

/** Split a newest-first log into days, newest day first. */
export function groupSyncHistoryByDay(entries: readonly SyncLogEntry[]): SyncHistoryDay[] {
  return groupByLocalDay(entries, (entry) => entry.at).map(({ at, items }) => ({
    at,
    entries: items,
  }));
}

/** Midnight of a timestamp's local day, in ms — the unit a day comparison needs. */
function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The local calendar day of a timestamp, as a comparable key. */
function localDayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${padTwo(date.getMonth() + 1)}-${padTwo(date.getDate())}`;
}

/** How a history row names the client that produced a version. */
export function deviceLabel(deviceName: string | null | undefined): string {
  return deviceName?.trim() || t("history.deviceUnknown");
}

/**
 * How one row names the client on the other end.
 *
 * An outgoing change always has this device's label (the host fills it in when the push
 * was made). An incoming change carries the pushing client's label only when a WebSocket
 * notification named it; a chain discovered by a reconcile does not, and "another device"
 * is the honest answer rather than "unknown".
 */
export function entryDeviceLabel(entry: Pick<SyncLogEntry, "direction" | "deviceName">): string {
  if (entry.deviceName?.trim()) return entry.deviceName.trim();
  return entry.direction === "in" ? t("dialog.syncHistory.peerUnknown") : deviceLabel(null);
}

/** A local timestamp for a version's `createdAt`, in the plugin UI's language. */
export function formatHistoryTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(getLocale() === "zh" ? "zh-CN" : "en-US");
}

/**
 * The day header of the log: 今天 / 昨天 / the date itself.
 *
 * The two relative words are what makes a log readable at a glance ("what happened
 * today" is the question people open it with); everything older gets the date, because
 * "3 days ago" is arithmetic the reader would rather not do when the row's own clock
 * reading is right underneath it.
 */
export function formatHistoryDay(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const days = Math.round((startOfLocalDay(new Date(now)) - startOfLocalDay(date)) / 86_400_000);
  if (days === 0) return t("dialog.syncHistory.today");
  if (days === 1) return t("dialog.syncHistory.yesterday");
  return date.toLocaleDateString(getLocale() === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * One event's clock reading, `18:07:41`.
 *
 * Deliberately not `toLocaleString()`: the day is the group header, so only the time
 * is left here — and a column of times is scanned rather than read as a sentence, so
 * the shape has to be fixed and zero-padded. Seconds are what tell two edits inside
 * the same minute apart.
 */
export function formatClockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${padTwo(date.getHours())}:${padTwo(date.getMinutes())}:${padTwo(date.getSeconds())}`;
}

/**
 * A count in the reader's own number format: `1,024` rather than `1024`.
 *
 * A run's log is a number a person reads off a header, and the grouping separator
 * is what makes four digits legible at a glance. It follows the UI language, like every
 * other date and number in the dialog.
 */
export function formatCount(value: number): string {
  return value.toLocaleString(getLocale() === "zh" ? "zh-CN" : "en-US");
}

/**
 * Why this device left a path out of a sync, worded as the switch that owns it.
 *
 * The reason comes from the engine's own decision at the time (`SyncActivityEvent`), so
 * this only turns it into words: a file under an excluded folder, a `.obsidian` group
 * left off, a file type switched off, the account's size cap and a path the API cannot
 * carry are five different settings pages, and naming the wrong one is worse than saying
 * nothing.
 */
export function skipReasonLabel(reason: SyncActivitySkipReason): string {
  switch (reason) {
    case "folder":
      return t("dialog.syncHistory.skipReason.folder");
    case "fileType":
      return t("dialog.syncHistory.skipReason.fileType");
    case "settingsGroup":
      return t("dialog.syncHistory.skipReason.settingsGroup");
    case "size":
      return t("dialog.syncHistory.skipReason.size");
    case "pathTooLong":
      return t("dialog.syncHistory.skipReason.pathTooLong");
  }
}

/**
 * The one line a skipped row adds, in the direction's own words.
 *
 * "Not applied" is about a change that arrived; "not sent" is about one made here. Both
 * are past tense on purpose: the row records the decision the engine made then, and a
 * switch flipped afterwards does not rewrite it.
 */
export function skipLine(entry: {
  direction: SyncLogEntry["direction"];
  reason: SyncActivitySkipReason;
}): string {
  const reason = skipReasonLabel(entry.reason);
  return entry.direction === "in"
    ? t("dialog.syncHistory.notApplied", { reason })
    : t("dialog.syncHistory.notSent", { reason });
}

/** What a row's arrow means, as a tooltip (direction only; the skip line carries the outcome). */
export function directionTooltip(direction: SyncLogEntry["direction"]): string {
  return direction === "out"
    ? t("dialog.syncHistory.directionOut")
    : t("dialog.syncHistory.directionIn");
}

/** What the dialog's header says about the list: the count, its label, and the note. */
export interface SyncHistorySummary {
  /** How many events this run recorded — not how many are on screen. */
  count: number;
  /** The word after the number ("条同步记录" / "sync events"). */
  label: string;
  /** The line under it: that this is a run's log, and how much of it is shown. */
  note: string;
}

/**
 * The header's numbers, as one value.
 *
 * Split out of the dialog because the count is the one thing a template can silently
 * lose: `t()` replaces a `{name}` placeholder only when that parameter is passed, so a
 * summary that renders a literal `{total}` still reads as a sentence and still passes
 * every assertion that looks for the surrounding words — which is exactly how the
 * dialog shipped showing "共 {total} 次同步事件。". Rendering it here gives the unit test
 * one value to pin.
 *
 * The note always says the log is this run's; when the buffer has evicted rows it also
 * says how many are on screen.
 */
export function syncHistorySummary(total: number, shown: number): SyncHistorySummary {
  return {
    count: total,
    label: plural(
      "dialog.syncHistory.countLabel.one",
      "dialog.syncHistory.countLabel.other",
      total,
    ),
    note:
      total > shown
        ? t("dialog.syncHistory.truncated", { shown })
        : t("dialog.syncHistory.sessionNote"),
  };
}

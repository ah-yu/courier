import type { FileVersionInfo, SyncAction } from "@courier/shared";
import { t } from "../i18n";
import { groupByLocalDay } from "./sync-history";

/**
 * The presentation rules of the version-history view: what a row's marker draws and how the
 * chain is cut into days.
 *
 * Kept apart from the view for the same reason `sync-history.ts` is: the copy and the
 * grouping are what a unit test can pin, and a view cannot be rendered in one (its DOM is the
 * app's, and the e2e suite drives it through the real workspace).
 */

/**
 * The lucide icon each action's marker draws.
 *
 * A `Record<SyncAction, string>` on purpose — a new action on the wire is a type error
 * here, not a row with a blank marker in the app.
 */
const VERSION_ACTION_ICONS: Record<SyncAction, string> = {
  create: "file-plus",
  modify: "pencil",
  rename: "arrow-right-left",
  delete: "trash-2",
  restore: "history",
};

/** The icon a version row leads with, from the action that produced it. */
export function versionActionIcon(action: SyncAction): string {
  return VERSION_ACTION_ICONS[action];
}

/** One day of a file's chain: the versions written on it, newest first. */
export interface VersionDay {
  /** `createdAt` of the day's newest version — what the day header is formatted from. */
  at: string;
  versions: FileVersionInfo[];
}

/**
 * Cut a newest-first chain into local days, newest day first.
 *
 * The server lists a chain oldest first (`getVersionChain` orders by `created_at, rowid`),
 * so the caller reverses it once — that reversal, not this function, is what makes the
 * dialog read newest first. Grouping only joins neighbouring versions, so a chain that
 * somehow arrived out of order is rendered as it arrived instead of being silently
 * re-sorted into a different history.
 */
export function groupVersionsByDay(versions: readonly FileVersionInfo[]): VersionDay[] {
  return groupByLocalDay(versions, (version) => version.createdAt).map(({ at, items }) => ({
    at,
    versions: items,
  }));
}

/**
 * A version's size in the unit a person reads.
 *
 * `B` under a kilobyte rather than a rounded `1 KB`: most versioned notes are a few hundred
 * bytes, and "1 KB" for five bytes describes a different file.
 */
export function formatVersionSize(sizeBytes: number): string {
  if (sizeBytes <= 0) return t("dialog.versionHistory.sizeEmpty");
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes >= 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

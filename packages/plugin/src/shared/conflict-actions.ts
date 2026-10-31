import { originalPathOfConflictFile } from "@courier/engine";
import { t, type PluginMessageKey } from "../i18n";
import { previewKindOf } from "./file-preview";

/**
 * What a parked conflict copy offers its user.
 *
 * The decision is the **preview kind** of the path, not "is it markdown": a text file
 * can be aligned and read line by line (`diff` — markdown, canvas, JSON, CSS), while
 * bytes with no readable structure (`replace` — images, audio, video, PDF, archives)
 * can only be chosen whole. Two actions, no merge: where the engine already decided
 * that the remote version wins, the user is choosing which copy to keep, and a merged
 * result would be content nobody wrote.
 */
export type ConflictActionKind = "diff" | "replace";

const CONFLICT_ACTION_KEYS: Record<
  ConflictActionKind,
  { title: PluginMessageKey; label: PluginMessageKey }
> = {
  diff: { title: "conflict.action.diff.title", label: "conflict.action.diff.label" },
  replace: { title: "conflict.action.replace.title", label: "conflict.action.replace.label" },
};

/** The button and menu label of each action, in the current UI language. */
export function conflictActionTitle(kind: ConflictActionKind): string {
  return t(CONFLICT_ACTION_KEYS[kind].title);
}

/**
 * What the row's action button says. Deliberately the two words a person uses for the
 * operations — an icon next to a file name does not say whether it compares or replaces —
 * and deliberately short, because it sits in a file-explorer row.
 */
export function conflictActionLabel(kind: ConflictActionKind): string {
  return t(CONFLICT_ACTION_KEYS[kind].label);
}

/** The icon each action draws (`obsidian`'s bundled set). */
export const CONFLICT_ACTION_ICONS: Record<ConflictActionKind, string> = {
  diff: "diff",
  replace: "replace",
};

/** Which action a conflict copy of `conflictPath` gets. */
export function conflictActionFor(conflictPath: string): ConflictActionKind {
  const kind = previewKindOf(conflictPath);
  return kind === "markdown" || kind === "text" ? "diff" : "replace";
}

/**
 * The paths a conflict copy could have been parked beside.
 *
 * The copy's name carries the stem and the extension it kept, which is enough for every
 * original that had an extension — except `.md`, which is **also** the fallback an
 * extension-less original was parked under: `README` and `README.md` both park as
 * `README-….conflict.md`. A `.md` copy therefore returns both readings, the name the copy
 * kept first, and the vault decides which one existed.
 */
export function conflictOriginalCandidates(conflictPath: string): string[] {
  const kept = originalPathOfConflictFile(conflictPath);
  if (kept === null) return [];
  if (!kept.endsWith(".md")) return [kept];
  return [kept, kept.slice(0, -".md".length)];
}

/**
 * The original path to act on: the first candidate the vault actually holds, or the
 * name the copy kept when the file is gone (which is exactly the path a restore would
 * write to). `null` only when the name is not a conflict copy's at all.
 */
export function resolveConflictOriginal(
  conflictPath: string,
  exists: (path: string) => boolean,
): string | null {
  const candidates = conflictOriginalCandidates(conflictPath);
  return candidates.find(exists) ?? candidates[0] ?? null;
}

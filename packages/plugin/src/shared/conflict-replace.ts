import { t } from "../i18n";

/**
 * The one interaction behind "用冲突副本替换当前文件".
 *
 * The action is a **user edit**, not a sync operation: the copy's bytes are written to
 * the original path through Obsidian's vault API, which fires the ordinary vault event
 * the engine already listens to. The engine then decides from its own rules — a tracked
 * path becomes a `modify` push, a path whose chain is a peer's tombstone becomes a new
 * chain — so nothing here has to know about sync state, and no conflict policy is added.
 *
 * The confirmation is deliberately one sentence and one choice: what will be overwritten,
 * and whether the parked copy should go with it. The long version spelled out the version
 * history, the sync and the possibility of a new conflict, and read as a wall of text for
 * a decision that is simply "use this copy, and keep the other one or not".
 *
 * This module holds the wording and the definitions only; the write and the dialog live
 * in `ui/dialogs/conflict-replace-modal.ts`, which needs Obsidian.
 */

/** How a replace ended: it overwrote the file, brought one back, or changed nothing. */
export type ReplaceOutcome = "replaced" | "created" | "failed";

/** The two paths the action needs. */
export interface ReplaceTarget {
  /** The parked copy (the source of the bytes). */
  conflictPath: string;
  /** Where the bytes go: the file the copy was parked beside. */
  originalPath: string;
}

/** Whether the path already holds a file, which is what decides the wording. */
export type ReplaceShape = "replace" | "recreate";

export function replaceShapeOf(originalExists: boolean): ReplaceShape {
  return originalExists ? "replace" : "recreate";
}

export function replaceConfirmTitle(shape: ReplaceShape): string {
  return t(
    shape === "replace"
      ? "dialog.conflictReplace.titleReplace"
      : "dialog.conflictReplace.titleRecreate",
  );
}

export function replaceConfirmButton(shape: ReplaceShape): string {
  return t(
    shape === "replace"
      ? "dialog.conflictReplace.buttonReplace"
      : "dialog.conflictReplace.buttonRecreate",
  );
}

/** The dialog's one sentence: which file the copy's content is about to become. */
export function replaceConfirmText(shape: ReplaceShape, target: ReplaceTarget): string {
  return t(
    shape === "replace"
      ? "dialog.conflictReplace.textReplace"
      : "dialog.conflictReplace.textRecreate",
    { path: target.originalPath },
  );
}

/** The dialog's one choice: whether the parked copy is deleted once the write landed. */
export function replaceDeleteCopyLabel(): string {
  return t("dialog.conflictReplace.deleteCopy");
}

/**
 * The one line shown after the write, or **null** when there is nothing worth saying.
 *
 * A successful replace is visible on its own: the file's content changes under the user,
 * in the note they are looking at. So silence is the default, and a notice is kept for
 * the two outcomes nobody can see — the write failed, or the parked copy was asked to be
 * deleted and was not.
 *
 * The input is one object rather than four positional arguments because two of them are
 * booleans with opposite meanings (`copyDeleted` / `deleteRequested`), and a call site that
 * swaps them still type-checks.
 */
export interface ReplaceNoticeInput {
  outcome: ReplaceOutcome;
  target: ReplaceTarget;
  /** Whether the copy is gone now. */
  copyDeleted: boolean;
  /** Whether the user asked for it to be deleted (the dialog's checkbox). */
  deleteRequested: boolean;
}

export function replaceNoticeText(input: ReplaceNoticeInput): string | null {
  const { outcome, target, copyDeleted, deleteRequested } = input;
  if (outcome === "failed") {
    return t("dialog.conflictReplace.noticeFailed", { path: target.originalPath });
  }
  if (!deleteRequested || copyDeleted) return null;
  const verb = t(
    outcome === "replaced"
      ? "dialog.conflictReplace.noticeReplaced"
      : "dialog.conflictReplace.noticeCreated",
    { path: target.originalPath },
  );
  return t("dialog.conflictReplace.noticeCopyKept", { verb });
}

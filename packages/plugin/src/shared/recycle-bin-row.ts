import { t } from "../i18n";

/**
 * What one recycle-bin row can do, and the line that says why.
 *
 * The rules live here rather than inside the dialog for the same reason the settings
 * page's step rule does (`settings-stage.ts`): they are what the e2e suite asserts and
 * what a reviewer has to be able to read in one place. The dialog only renders them.
 *
 * Two facts decide a row, and they are independent:
 *
 * - **restorable** — the server still holds the version *before* the delete. Retention
 *   pruning eventually removes it (leaving the chain nothing but its tombstone), and a
 *   chain in that state has no content to show either: that version *is* the content.
 * - **pathKnown** — that stored path decrypted. A row whose path will not decrypt has
 *   content to fetch and nowhere to write it, which is a different failure from pruning
 *   and says so with its own line.
 *
 * Whether the path a restore would write to is occupied is deliberately **not** one of
 * them: the row does not predict it. The click-time flow asks the engine for the real
 * target and, when it is taken, opens `RestorePathModal` for another file name — a
 * warning line under every row that merely *might* collide was noise next to a dialog
 * that already answers the question.
 */
export interface DeletedFileRowInput {
  /** A restorable version exists on the server (`previousContentHash`). */
  restorable: boolean;
  /** The path that version records was decrypted (`lastEncryptedPath`). */
  pathKnown: boolean;
}

/** How a row renders, and what it explains. */
export interface DeletedFileRowState {
  /** Whether the 恢复 button is offered. It is **disabled**, never hidden: the row
   * still says what it is, and the reason is the warning line under the path. */
  canRestore: boolean;
  /** Whether clicking the row opens the deleted version's content. */
  canPreview: boolean;
  /** The line under the path, or `null` when there is nothing to warn about. */
  warning: string | null;
}

export function deletedFileRowState(input: DeletedFileRowInput): DeletedFileRowState {
  if (!input.restorable) {
    return {
      canRestore: false,
      // The restorable version is the one with content: without it there is nothing to
      // fetch, and no path that would name the format.
      canPreview: false,
      warning: t("dialog.recycleBin.warning.pruned"),
    };
  }

  if (!input.pathKnown) {
    // There is content, but no path to write it to — and the preview names its format
    // from that path, so it has nothing to render either.
    return {
      canRestore: false,
      canPreview: false,
      warning: t("dialog.recycleBin.warning.pathUnknown"),
    };
  }

  return {
    canRestore: true,
    canPreview: true,
    warning: null,
  };
}

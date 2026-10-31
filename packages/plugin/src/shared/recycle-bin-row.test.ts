import { beforeEach, describe, expect, it } from "vitest";
import { setLocale, t } from "../i18n";
import { deletedFileRowState } from "./recycle-bin-row";

beforeEach(() => setLocale("zh"));

describe("deletedFileRowState", () => {
  it("offers a restore and no warning for an ordinary deleted file", () => {
    expect(deletedFileRowState({ restorable: true, pathKnown: true })).toEqual({
      canRestore: true,
      canPreview: true,
      warning: null,
    });
  });

  it("disables the restore, and the content, when the restorable version is gone", () => {
    // Retention pruning left the chain nothing but its tombstone.
    expect(deletedFileRowState({ restorable: false, pathKnown: true })).toEqual({
      canRestore: false,
      canPreview: false,
      warning: t("dialog.recycleBin.warning.pruned"),
    });
  });

  it("blames the path, not pruning, when the stored path will not decrypt", () => {
    // There *is* content — the row simply has no path to write it to, and the preview
    // names its format from that path, so neither action is offered.
    expect(deletedFileRowState({ restorable: true, pathKnown: false })).toEqual({
      canRestore: false,
      canPreview: false,
      warning: t("dialog.recycleBin.warning.pathUnknown"),
    });
    // A pruned chain has no path either, and that is the reason worth reporting.
    expect(deletedFileRowState({ restorable: false, pathKnown: false })).toEqual({
      canRestore: false,
      canPreview: false,
      warning: t("dialog.recycleBin.warning.pruned"),
    });
  });
});

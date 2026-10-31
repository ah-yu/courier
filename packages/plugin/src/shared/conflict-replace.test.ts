import { beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "../i18n";
import {
  replaceConfirmButton,
  replaceConfirmText,
  replaceConfirmTitle,
  replaceDeleteCopyLabel,
  replaceNoticeText,
  replaceShapeOf,
  type ReplaceTarget,
} from "./conflict-replace";

beforeEach(() => setLocale("zh"));

const target: ReplaceTarget = {
  conflictPath: "photos/raw-2026-02-14-101530.conflict.png",
  originalPath: "photos/raw.png",
};

describe("replaceShapeOf", () => {
  it("names the action after whether the file is there", () => {
    expect(replaceShapeOf(true)).toBe("replace");
    expect(replaceShapeOf(false)).toBe("recreate");
    expect(replaceConfirmTitle("replace")).toBe("用冲突副本替换当前文件");
    expect(replaceConfirmTitle("recreate")).toBe("恢复为原文件");
    expect(replaceConfirmButton("replace")).toBe("替换");
    expect(replaceConfirmButton("recreate")).toBe("恢复");
  });
});

describe("replaceConfirmText", () => {
  it("says in one sentence which file the copy's content becomes", () => {
    expect(replaceConfirmText("replace", target)).toBe("将用冲突副本覆盖「photos/raw.png」。");
    expect(replaceConfirmText("recreate", target)).toBe(
      "原文件不存在，将按冲突副本创建「photos/raw.png」。",
    );
  });

  it("offers the copy's fate as one labelled choice", () => {
    expect(replaceDeleteCopyLabel()).toBe("替换后删除冲突副本");
  });
});

describe("replaceNoticeText", () => {
  it("says nothing when the write landed and the copy's fate is the one asked for", () => {
    // The content changes under the user, so a success line would only repeat it.
    expect(
      replaceNoticeText({
        outcome: "replaced",
        target,
        copyDeleted: false,
        deleteRequested: false,
      }),
    ).toBeNull();
    expect(
      replaceNoticeText({ outcome: "created", target, copyDeleted: false, deleteRequested: false }),
    ).toBeNull();
    // Asked to delete the copy, and it is gone: also nothing to say.
    expect(
      replaceNoticeText({ outcome: "replaced", target, copyDeleted: true, deleteRequested: true }),
    ).toBeNull();
  });

  it("says what happened when the copy was meant to go and is still there", () => {
    expect(
      replaceNoticeText({ outcome: "replaced", target, copyDeleted: false, deleteRequested: true }),
    ).toBe("已用冲突副本替换「photos/raw.png」，冲突副本仍保留。");
    expect(
      replaceNoticeText({ outcome: "created", target, copyDeleted: false, deleteRequested: true }),
    ).toBe("已按冲突副本创建「photos/raw.png」，冲突副本仍保留。");
  });

  it("says nothing changed when the write failed, and never claims a deletion", () => {
    const text = replaceNoticeText({
      outcome: "failed",
      target,
      copyDeleted: true,
      deleteRequested: true,
    });
    expect(text).toContain("失败");
    expect(text).toContain("没有任何文件被改动");
    expect(text).not.toContain("已删除");
  });
});

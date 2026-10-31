import { beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "../i18n";
import { conflictNoticeText } from "./conflict-notice";
import type { ConflictResolvedEvent } from "@courier/engine";

beforeEach(() => setLocale("zh"));

function event(overrides: Partial<ConflictResolvedEvent> = {}): ConflictResolvedEvent {
  return {
    fileId: "f1",
    plainPath: "plan.md",
    conflictPath: "plan-2026-02-14-101530.conflict.md",
    remoteAction: "write",
    ...overrides,
  };
}

describe("conflictNoticeText", () => {
  it("says nothing when there is nothing to report", () => {
    expect(conflictNoticeText([])).toBe("");
  });

  it("names the file the local content was parked in", () => {
    const text = conflictNoticeText([event()]);
    expect(text).toContain("plan-2026-02-14-101530.conflict.md");
    expect(text).toContain("远程版本");
  });

  it("summarises a burst as one line that still names a file", () => {
    const text = conflictNoticeText([
      event(),
      event({ conflictPath: "other-2026-02-14-101530.conflict.md", plainPath: "other.md" }),
    ]);
    expect(text).toContain("2 处冲突");
    expect(text).toContain("2 个冲突副本");
    expect(text).toContain("plan-2026-02-14-101530.conflict.md");
  });

  it("names a parked binary copy by its own path, extension and all", () => {
    const text = conflictNoticeText([
      event({
        plainPath: "photos/raw.png",
        conflictPath: "photos/raw-2026-02-14-101530.conflict.png",
      }),
    ]);
    expect(text).toContain("photos/raw-2026-02-14-101530.conflict.png");
    // The copy is not a Markdown file, so the notice must not pretend it is one.
    expect(text).not.toContain(".conflict.md");
  });

  it("does not promise a conflict file when there was no local content", async () => {
    const deleted = event({ conflictPath: null, remoteAction: "delete" });
    const text = conflictNoticeText([deleted]);
    expect(text).toContain("本地没有需要保留的内容");
    expect(text).not.toContain(".conflict.md");

    // A burst where only some conflicts parked content still reports the count of
    // files the user can actually look for.
    const mixed = conflictNoticeText([deleted, event()]);
    expect(mixed).toContain("2 处冲突");
    expect(mixed).toContain("「plan-2026-02-14-101530.conflict.md」");
  });
});

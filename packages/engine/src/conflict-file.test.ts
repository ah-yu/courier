import { describe, expect, it } from "vitest";
import { conflictFilePath, isConflictFile, originalPathOfConflictFile } from "./conflict-file";

describe("conflictFilePath", () => {
  // Built in local time, because the name is: `new Date("…Z")` would make the expected
  // date depend on the machine's timezone.
  const now = new Date(2026, 1, 14, 10, 15, 30);

  it("names the file after the note and the time it was parked", () => {
    expect(conflictFilePath("notes/plan.md", now)).toBe("notes/plan-2026-02-14-101530.conflict.md");
  });

  it("pads every part of the timestamp", () => {
    expect(conflictFilePath("plan.md", new Date(2026, 0, 2, 3, 4, 5))).toBe(
      "plan-2026-01-02-030405.conflict.md",
    );
  });

  it("keeps a name that has no extension, and one that only starts with a dot", () => {
    expect(conflictFilePath("README", now)).toBe("README-2026-02-14-101530.conflict.md");
    // `.md` has no stem to strip — `dot > 0` keeps the whole name.
    expect(conflictFilePath(".md", now)).toBe(".md-2026-02-14-101530.conflict.md");
  });

  it("disambiguates a second conflict parked inside the same second", () => {
    expect(conflictFilePath("plan.md", now, 1)).toBe("plan-2026-02-14-101530.conflict.md");
    expect(conflictFilePath("plan.md", now, 2)).toBe("plan-2026-02-14-101530-2.conflict.md");
    expect(conflictFilePath("plan.md", now, 3)).toBe("plan-2026-02-14-101530-3.conflict.md");
  });

  it("keeps the original extension, so a parked binary is still openable", () => {
    expect(conflictFilePath("photos/raw.png", now)).toBe(
      "photos/raw-2026-02-14-101530.conflict.png",
    );
    expect(conflictFilePath("boards/plan.canvas", now)).toBe(
      "boards/plan-2026-02-14-101530.conflict.canvas",
    );
    expect(conflictFilePath("notes/plan.md", now, 2)).toBe(
      "notes/plan-2026-02-14-101530-2.conflict.md",
    );
  });

  it("splits the extension off the file name, not the folder", () => {
    // A folder whose name contains a dot must keep its folder: the parked copy belongs
    // beside the original, not at the vault root.
    expect(conflictFilePath("notes.v2/plan", now)).toBe(
      "notes.v2/plan-2026-02-14-101530.conflict.md",
    );
    expect(conflictFilePath("a.b/c/photo.png", now)).toBe(
      "a.b/c/photo-2026-02-14-101530.conflict.png",
    );
  });
});

describe("originalPathOfConflictFile", () => {
  const now = new Date(2026, 1, 14, 10, 15, 30);

  it("answers the path the copy was parked beside", () => {
    expect(originalPathOfConflictFile("notes/plan-2026-02-14-101530.conflict.md")).toBe(
      "notes/plan.md",
    );
    expect(originalPathOfConflictFile("photos/raw-2026-02-14-101530.conflict.png")).toBe(
      "photos/raw.png",
    );
    expect(originalPathOfConflictFile("boards/plan-2026-02-14-101530-2.conflict.canvas")).toBe(
      "boards/plan.canvas",
    );
    expect(originalPathOfConflictFile("plan-2026-02-14-101530.conflict.md")).toBe("plan.md");
  });

  it("round-trips every name conflictFilePath builds", () => {
    // An extension-less original is parked with the `.md` fallback, so the answer carries
    // that extension: the copy's name cannot say whether the original ended in `.md`.
    const cases: Array<[string, string]> = [
      ["notes/plan.md", "notes/plan.md"],
      ["photos/raw.png", "photos/raw.png"],
      ["boards/plan.canvas", "boards/plan.canvas"],
      ["README", "README.md"],
      [".md", ".md.md"],
      ["notes.v2/plan", "notes.v2/plan.md"],
      ["a.b/c/photo.png", "a.b/c/photo.png"],
      // A stem that itself looks like a timestamp still round-trips: the greedy match takes
      // the **last** stamp, which is the one conflictFilePath appended.
      ["plan-2026-02-14-101530.md", "plan-2026-02-14-101530.md"],
      ["photo.conflict.png", "photo.conflict.png"],
    ];
    for (const [original, expected] of cases) {
      for (const index of [1, 2, 7]) {
        const parked = conflictFilePath(original, now, index);
        expect(originalPathOfConflictFile(parked), parked).toBe(expected);
      }
    }
  });

  it("agrees with isConflictFile on what a parked copy is", () => {
    for (const path of [
      "plan-2026-02-14-101530.conflict.md",
      "photos/raw-2026-02-14-101530-2.conflict.png",
      "LICENSE-2026-02-14-101530.conflict",
      "plan.md",
      "plan-2026-02-14.conflict.md",
      "plan-2026-02-14-101530.md",
      "conflict.md",
      "folder/deep/plan-2026-02-14-101530.conflict.md",
    ]) {
      expect(originalPathOfConflictFile(path) !== null, path).toBe(isConflictFile(path));
    }
  });

  it("keeps a no-extension copy's fallback readable, not the caseless empty name", () => {
    // `LICENSE` parks as `LICENSE-….conflict.md`; a name that ends `.conflict` with no
    // extension at all is read the same way, because that is the name the copy kept.
    expect(originalPathOfConflictFile("LICENSE-2026-02-14-101530.conflict")).toBe("LICENSE.md");
  });
});

describe("isConflictFile", () => {
  it("matches parked conflict files, counter suffix included", () => {
    expect(isConflictFile("plan-2026-02-14-101530.conflict.md")).toBe(true);
    expect(isConflictFile("folder/deep/plan-2026-02-14-101530-2.conflict.md")).toBe(true);
  });

  it("matches a parked copy of a binary file (the extension is kept)", () => {
    expect(isConflictFile("photos/raw-2026-02-14-101530.conflict.png")).toBe(true);
    expect(isConflictFile("audio/take-2026-02-14-101530-2.conflict.mp3")).toBe(true);
    expect(isConflictFile("LICENSE-2026-02-14-101530.conflict")).toBe(true);
  });

  it("does not match a name that only carries a date", () => {
    // The pattern is exactly the name `conflictFilePath` builds, and nothing else: a copy
    // parked by an older version under a day-precision name is an ordinary file now.
    expect(isConflictFile("plan-2026-02-14.conflict.md")).toBe(false);
    expect(isConflictFile("folder/deep/plan-2026-02-14-2.conflict.md")).toBe(false);
  });

  it("does not match ordinary files", () => {
    expect(isConflictFile("plan.md")).toBe(false);
    expect(isConflictFile("plan-2026-02-14-101530.md")).toBe(false);
    expect(isConflictFile("a-2026-02-14-101530.txt")).toBe(false);
    // A missing or malformed date must not be read as a parked file.
    expect(isConflictFile("plan-26-02-14.conflict.md")).toBe(false);
    expect(isConflictFile("plan-2026-2-14.conflict.md")).toBe(false);
    expect(isConflictFile("conflict.md")).toBe(false);
    // A short timestamp is neither the time nor a counter, so it names no parked copy.
    expect(isConflictFile("plan-2026-02-14-10153.conflict.md")).toBe(false);
    // The timestamp is not a separator this pattern knows: only `-`-joined digits are.
    expect(isConflictFile("plan-2026-02-14T101530.conflict.md")).toBe(false);
    expect(isConflictFile("plan-2026-02-14-.conflict.md")).toBe(false);
  });

  it("covers every name conflictFilePath produces", () => {
    for (const index of [1, 2, 7]) {
      expect(isConflictFile(conflictFilePath("notes/plan.md", new Date(), index))).toBe(true);
      expect(isConflictFile(conflictFilePath("photos/raw.png", new Date(), index))).toBe(true);
    }
  });
});

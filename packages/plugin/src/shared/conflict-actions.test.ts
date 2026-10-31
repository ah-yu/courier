import { describe, expect, it } from "vitest";
import {
  conflictActionFor,
  conflictOriginalCandidates,
  resolveConflictOriginal,
} from "./conflict-actions";

/** The name the engine would park for `original` (kept extension, local timestamp). */
function copy(original: string): string {
  const dot = original.lastIndexOf(".");
  const slash = original.lastIndexOf("/");
  const stamp = "2026-02-14-101530";
  return dot > slash
    ? `${original.slice(0, dot)}-${stamp}.conflict${original.slice(dot)}`
    : `${original}-${stamp}.conflict.md`;
}

describe("conflictActionFor", () => {
  it("diffs what can be read line by line", () => {
    expect(conflictActionFor("notes/plan-2026-02-14-101530.conflict.md")).toBe("diff");
    expect(conflictActionFor("boards/plan-2026-02-14-101530.conflict.canvas")).toBe("diff");
    expect(conflictActionFor("data/base-2026-02-14-101530.conflict.json")).toBe("diff");
    expect(conflictActionFor("snippets/wide-2026-02-14-101530.conflict.css")).toBe("diff");
  });

  it("replaces what has no readable structure", () => {
    expect(conflictActionFor("photos/raw-2026-02-14-101530.conflict.png")).toBe("replace");
    expect(conflictActionFor("clip-2026-02-14-101530.conflict.mp4")).toBe("replace");
    expect(conflictActionFor("take-2026-02-14-101530.conflict.mp3")).toBe("replace");
    expect(conflictActionFor("paper-2026-02-14-101530.conflict.pdf")).toBe("replace");
    // `.svg` is text but Obsidian's table calls it an image, and the category wins there.
    expect(conflictActionFor("icon-2026-02-14-101530.conflict.svg")).toBe("replace");
    expect(conflictActionFor("notes-2026-02-14-101530.conflict")).toBe("replace");
  });
});

describe("conflictOriginalCandidates", () => {
  it("answers the path the copy was parked beside", () => {
    // A `.md` copy always carries the extension-less reading too: `.md` is also the
    // fallback an extension-less original was parked under, and the name cannot say which.
    expect(conflictOriginalCandidates("notes/plan-2026-02-14-101530.conflict.md")).toEqual([
      "notes/plan.md",
      "notes/plan",
    ]);
    expect(conflictOriginalCandidates(copy("photos/raw.png"))).toEqual(["photos/raw.png"]);
  });

  it("offers both readings of an extension-less original's fallback `.md`", () => {
    // `README` and `README.md` park under the same name; only the vault can say which one
    // existed, so both are candidates with the name the copy kept first.
    expect(conflictOriginalCandidates("README-2026-02-14-101530.conflict.md")).toEqual([
      "README.md",
      "README",
    ]);
    expect(conflictOriginalCandidates("LICENSE-2026-02-14-101530.conflict")).toEqual([
      "LICENSE.md",
      "LICENSE",
    ]);
  });

  it("answers nothing for a name that is not a parked copy", () => {
    expect(conflictOriginalCandidates("plan.md")).toEqual([]);
    expect(conflictOriginalCandidates("plan-2026-02-14.conflict.md")).toEqual([]);
  });
});

const existsIn =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path);

describe("resolveConflictOriginal", () => {
  it("prefers the exact path, then the extension-less reading", () => {
    expect(
      resolveConflictOriginal("README-2026-02-14-101530.conflict.md", existsIn("README.md")),
    ).toBe("README.md");
    expect(
      resolveConflictOriginal("README-2026-02-14-101530.conflict.md", existsIn("README")),
    ).toBe("README");
    expect(
      resolveConflictOriginal(
        "README-2026-02-14-101530.conflict.md",
        existsIn("README.md", "README"),
      ),
    ).toBe("README.md");
  });

  it("falls back to the name the copy kept when the file is gone", () => {
    // The path a restore would write to: the copy's own extension is the best evidence
    // there is, and "file not found" is a state the dialog renders.
    expect(resolveConflictOriginal("notes/plan-2026-02-14-101530.conflict.md", () => false)).toBe(
      "notes/plan.md",
    );
  });

  it("answers null when the name is not a parked copy's", () => {
    expect(resolveConflictOriginal("plan.md", () => true)).toBeNull();
  });
});

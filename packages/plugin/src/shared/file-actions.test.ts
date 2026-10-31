import { describe, expect, it } from "vitest";
import { fileActionFor } from "./file-actions";

/**
 * The predicate behind the plugin's two entry points.
 *
 * The chips and the file menu both call {@link fileActionFor}, so these cases are what
 * pins "a file this device does not sync gets no Courier action" — the surfaces
 * themselves (DOM decoration, menu items) are covered by the L2/L3 suites.
 */

describe("fileActionFor", () => {
  it("offers the version history on an ordinary file", () => {
    expect(fileActionFor("notes/plan.md", [])).toBe("history");
    expect(fileActionFor("plan.png", [])).toBe("history");
  });

  it("offers the conflict actions on a parked copy, and only there", () => {
    expect(fileActionFor("notes/plan-2026-02-14-101530.conflict.md", [])).toBe("conflict");
    expect(fileActionFor("photos/raw-2026-02-14-101530-2.conflict.png", [])).toBe("conflict");
    // A file that merely looks like a conflict copy but is not stamped is ordinary.
    expect(fileActionFor("notes/plan.conflict.md", [])).toBe("history");
  });

  it("offers nothing inside an excluded folder, at any depth", () => {
    const excluded = ["private"];
    expect(fileActionFor("private", excluded)).toBeNull();
    expect(fileActionFor("private/plan.md", excluded)).toBeNull();
    expect(fileActionFor("private/deep/plan.md", excluded)).toBeNull();
    // A parked copy under an excluded folder is not one the engine made — and the file
    // menu must not offer to diff or replace a file this device keeps out of sync.
    expect(fileActionFor("private/plan-2026-02-14-101530.conflict.md", excluded)).toBeNull();
  });

  it("keeps a folder that only shares a name prefix in scope", () => {
    const excluded = ["private"];
    expect(fileActionFor("private-notes/plan.md", excluded)).toBe("history");
    expect(fileActionFor("private-notes/plan-2026-02-14-101530.conflict.md", excluded)).toBe(
      "conflict",
    );
  });

  it("follows a nested exclusion and the folder's own subfolders", () => {
    const excluded = ["projects/archive"];
    expect(fileActionFor("projects/plan.md", excluded)).toBe("history");
    expect(fileActionFor("projects/archive/plan.md", excluded)).toBeNull();
    expect(fileActionFor("projects/archive/2026/plan.md", excluded)).toBeNull();
  });
});

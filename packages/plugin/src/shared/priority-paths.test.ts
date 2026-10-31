import { describe, expect, it } from "vitest";
import { priorityPathsFrom } from "./priority-paths";

function workspace(
  active: string | null,
  lastOpen: string[],
): {
  getActiveFile: () => { path: string } | null;
  getLastOpenFiles: () => string[];
} {
  return {
    getActiveFile: () => (active === null ? null : { path: active }),
    getLastOpenFiles: () => lastOpen,
  };
}

describe("priorityPathsFrom", () => {
  it("puts the open note before the recently opened ones", () => {
    expect(priorityPathsFrom(workspace("notes/open.md", ["notes/recent.md", "a.md"]))).toEqual([
      "notes/open.md",
      "notes/recent.md",
      "a.md",
    ]);
  });

  it("keeps the active note once when Obsidian already lists it as recent", () => {
    expect(priorityPathsFrom(workspace("notes/open.md", ["notes/open.md", "a.md"]))).toEqual([
      "notes/open.md",
      "a.md",
    ]);
  });

  it("falls back to the recent list when no file view is active", () => {
    expect(priorityPathsFrom(workspace(null, ["a.md", "b.md"]))).toEqual(["a.md", "b.md"]);
  });

  it("answers an empty list when the workspace knows nothing — before the layout is ready", () => {
    expect(priorityPathsFrom(workspace(null, []))).toEqual([]);
  });

  it("drops empty entries instead of asking the engine to rank a path that names nothing", () => {
    expect(priorityPathsFrom(workspace(null, ["", "a.md", ""]))).toEqual(["a.md"]);
  });
});

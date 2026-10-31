import { describe, expect, it } from "vitest";
import {
  buildExcludedFolderTree,
  compactExcludedFolders,
  hasExcludedAncestor,
  isFolderCoveredByExclusion,
  toggleExcludedFolder,
  type ExcludedFolderNode,
} from "./excluded-folders";

/**
 * The folder-tree logic behind the manage dialog.
 *
 * The dialog's visible behaviour is the engine's prefix rule: excluding `projects`
 * covers `projects/create NFT's`, so a child cannot be unchecked while its parent is
 * excluded. These cases pin that rule, the compact list the dialog saves, and the tree
 * build that makes a stored path which does not exist yet still visible.
 */

function flatten(nodes: ExcludedFolderNode[]): Array<{ path: string; depth: number }> {
  return nodes.flatMap((node) => [
    { path: node.path, depth: node.depth },
    ...flatten(node.children),
  ]);
}

describe("compactExcludedFolders", () => {
  it("drops exclusions already covered by a parent, parent first", () => {
    expect(
      compactExcludedFolders([
        "projects/create NFT's",
        "projects",
        "daily",
        "projects/create NFT's/refs",
      ]),
    ).toEqual(["daily", "projects"]);
  });

  it("normalizes separators and stray slashes before deciding", () => {
    expect(compactExcludedFolders([" /projects/ ", "projects\\assets", "daily//notes"])).toEqual([
      "projects",
      "daily/notes",
    ]);
  });

  it("keeps a sibling whose name only shares a prefix", () => {
    expect(compactExcludedFolders(["projects", "projects2"])).toEqual(["projects", "projects2"]);
  });
});

describe("exclusion coverage", () => {
  const excluded = ["projects", "daily/notes"];

  it("covers the folder itself and every path under it", () => {
    expect(isFolderCoveredByExclusion("projects", excluded)).toBe(true);
    expect(isFolderCoveredByExclusion("projects/create NFT's", excluded)).toBe(true);
    expect(isFolderCoveredByExclusion("daily/notes/today.md", excluded)).toBe(true);
    expect(isFolderCoveredByExclusion("daily", excluded)).toBe(false);
    expect(isFolderCoveredByExclusion("projects2", excluded)).toBe(false);
  });

  it("distinguishes an ancestor exclusion from the folder's own entry", () => {
    // The dialog disables a checkbox only when an **ancestor** covers it: the folder's
    // own entry is the one the user can still uncheck.
    expect(hasExcludedAncestor("projects/create NFT's", excluded)).toBe(true);
    expect(hasExcludedAncestor("projects", excluded)).toBe(false);
    expect(hasExcludedAncestor("daily/notes/today", excluded)).toBe(true);
  });
});

describe("toggleExcludedFolder", () => {
  it("checking a parent replaces the exclusions inside it", () => {
    expect(toggleExcludedFolder(["projects/create NFT's"], "projects", true)).toEqual(["projects"]);
    expect(toggleExcludedFolder([], "projects", true)).toEqual(["projects"]);
  });

  it("unchecking removes exactly that folder and leaves an unrelated entry alone", () => {
    expect(toggleExcludedFolder(["projects", "daily"], "projects", false)).toEqual(["daily"]);
    expect(toggleExcludedFolder(["daily"], "projects", false)).toEqual(["daily"]);
  });
});

describe("buildExcludedFolderTree", () => {
  it("builds nested nodes with implicit parents, sorted by name", () => {
    const tree = buildExcludedFolderTree([
      "projects/create NFT's/refs",
      "daily",
      "projects",
      "archive/2025",
    ]);

    expect(flatten(tree)).toEqual([
      { path: "archive", depth: 0 },
      { path: "archive/2025", depth: 1 },
      { path: "daily", depth: 0 },
      { path: "projects", depth: 0 },
      { path: "projects/create NFT's", depth: 1 },
      { path: "projects/create NFT's/refs", depth: 2 },
    ]);
    // The list is a tree, not a flat ordering: each child hangs off its own parent.
    expect(tree[2]!.children[0]!.children[0]!.name).toBe("refs");
  });

  it("normalizes separators and drops empty, dot and traversal segments", () => {
    expect(
      flatten(buildExcludedFolderTree([" /projects/ ", "projects\\assets", "./", ".."])),
    ).toEqual([
      { path: "projects", depth: 0 },
      { path: "projects/assets", depth: 1 },
    ]);
  });

  it("rejects a whole path that contains a traversal segment, like the normalizer", () => {
    // `normalizeExcludedFolders` drops the entry, so the tree must not turn
    // `a/../b` into `a/b` and show a folder the engine would never exclude.
    expect(flatten(buildExcludedFolderTree(["a/../b"]))).toEqual([]);
  });

  it("sorts siblings at every depth, so the dialog is stable across renders", () => {
    const tree = buildExcludedFolderTree(["projects/z", "projects/a", "alpha", "zeta"]);
    expect(flatten(tree)).toEqual([
      { path: "alpha", depth: 0 },
      { path: "projects", depth: 0 },
      { path: "projects/a", depth: 1 },
      { path: "projects/z", depth: 1 },
      { path: "zeta", depth: 0 },
    ]);
  });

  it("returns no nodes for an empty folder list", () => {
    expect(buildExcludedFolderTree([])).toEqual([]);
  });
});

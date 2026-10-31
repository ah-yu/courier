import { describe, expect, it } from "vitest";
import {
  decorateExcludedPathRow,
  EXCLUDED_PATH_ROW_CLASS,
  type PathTitleElement,
} from "./file-explorer-excluded-folders";

/**
 * The file explorer's excluded-content dimming rule.
 *
 * The explorer itself only exists in Obsidian, but the decision is pure: a row gets the
 * class when the row's path is covered by an exclusion; every other case removes it.
 * Folder rows and file rows carry the same `data-path`, so one rule covers both and the
 * test drives either through the same minimal element.
 */
function row(path: string | null): { element: PathTitleElement; classes: Set<string> } {
  const classes = new Set<string>();
  const element: PathTitleElement = {
    getAttribute: (name) => (name === "data-path" ? path : null),
    addClass: (cls) => {
      classes.add(cls);
    },
    removeClass: (cls) => {
      classes.delete(cls);
    },
  };
  return { element, classes };
}

describe("decorateExcludedPathRow", () => {
  const excluded = ["projects", "daily/notes"];

  it("dims an excluded folder, its descendant folders and the files inside them", () => {
    const parent = row("projects");
    const childFolder = row("projects/create NFT's");
    const childFile = row("projects/create NFT's/plan.md");
    const deepFile = row("daily/notes/today.md");
    for (const { element } of [parent, childFolder, childFile, deepFile]) {
      decorateExcludedPathRow(element, excluded);
    }
    expect(parent.classes).toContain(EXCLUDED_PATH_ROW_CLASS);
    expect(childFolder.classes).toContain(EXCLUDED_PATH_ROW_CLASS);
    expect(childFile.classes).toContain(EXCLUDED_PATH_ROW_CLASS);
    expect(deepFile.classes).toContain(EXCLUDED_PATH_ROW_CLASS);
  });

  it("leaves a path outside the excluded folders normal", () => {
    const folder = row("daily");
    const file = row("daily/plan.md");
    for (const { element } of [folder, file]) decorateExcludedPathRow(element, excluded);
    expect(folder.classes).not.toContain(EXCLUDED_PATH_ROW_CLASS);
    expect(file.classes).not.toContain(EXCLUDED_PATH_ROW_CLASS);
  });

  it("removes the class when the exclusion no longer covers the row", () => {
    const { element, classes } = row("projects/plan.md");
    classes.add(EXCLUDED_PATH_ROW_CLASS);
    decorateExcludedPathRow(element, []);
    expect(classes).not.toContain(EXCLUDED_PATH_ROW_CLASS);
  });

  it("removes a stale class when the row is renamed to a non-excluded path", () => {
    const { element, classes } = row("archive");
    classes.add(EXCLUDED_PATH_ROW_CLASS);
    decorateExcludedPathRow(element, excluded);
    expect(classes).not.toContain(EXCLUDED_PATH_ROW_CLASS);
  });

  it("leaves a row with no path alone (except for removing a stale class)", () => {
    const { element, classes } = row(null);
    classes.add(EXCLUDED_PATH_ROW_CLASS);
    decorateExcludedPathRow(element, excluded);
    expect(classes).not.toContain(EXCLUDED_PATH_ROW_CLASS);
  });
});

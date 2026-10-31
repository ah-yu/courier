import { describe, expect, it } from "vitest";
import {
  MAX_RESTORE_NAME_ATTEMPTS,
  freeRestorePath,
  numberedRestorePath,
  splitVaultPath,
} from "./restore-name";

describe("splitVaultPath", () => {
  it("separates a nested path from its file name", () => {
    expect(splitVaultPath("notes/deep/hero.md")).toEqual({ dir: "notes/deep", name: "hero.md" });
    // A root file has no folder, not an empty one with a leading slash.
    expect(splitVaultPath("hero.md")).toEqual({ dir: "", name: "hero.md" });
  });
});

describe("numberedRestorePath", () => {
  it("puts the number before the extension, keeping the folder", () => {
    expect(numberedRestorePath("notes/hero.md", 1)).toBe("notes/hero-1.md");
    expect(numberedRestorePath("hero.md", 2)).toBe("hero-2.md");
    expect(numberedRestorePath("photos/raw.png", 3)).toBe("photos/raw-3.png");
  });

  it("appends for a file with no extension, and for a dot-name", () => {
    // No extension to insert before: the number goes at the end.
    expect(numberedRestorePath("LICENSE", 1)).toBe("LICENSE-1");
    // A leading dot is a name, not an extension separator (`extensionOf` agrees).
    expect(numberedRestorePath(".gitignore", 1)).toBe(".gitignore-1");
  });

  it("keeps a dotted folder out of the decision", () => {
    // Obsidian paths use `/`, so a folder called `notes.v2` never looks like an extension.
    expect(numberedRestorePath("notes.v2/hero.md", 1)).toBe("notes.v2/hero-1.md");
  });
});

describe("freeRestorePath", () => {
  it("offers -1 when it is free", async () => {
    const asked: string[] = [];
    const path = await freeRestorePath("hero.md", async (candidate) => {
      asked.push(candidate);
      return true;
    });
    expect(path).toBe("hero-1.md");
    // One probe: the common case costs a single check.
    expect(asked).toEqual(["hero-1.md"]);
  });

  it("raises the number past the names that are taken", async () => {
    const taken = new Set(["hero-1.md", "hero-2.md"]);
    const path = await freeRestorePath("hero.md", async (candidate) => !taken.has(candidate));
    expect(path).toBe("hero-3.md");
  });

  it("stops probing and answers -1 when everything is taken", async () => {
    let calls = 0;
    const path = await freeRestorePath("hero.md", async () => {
      calls++;
      return false;
    });
    expect(path).toBe("hero-1.md");
    // Bounded: the dialog's own validation is what answers a vault this full.
    expect(calls).toBe(MAX_RESTORE_NAME_ATTEMPTS);
  });
});

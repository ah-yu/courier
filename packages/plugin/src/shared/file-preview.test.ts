import { describe, expect, it } from "vitest";
import { mimeTypeFor, previewIconOf, previewKindOf } from "./file-preview";

/**
 * The preview rule is the recycle bin's (and the version-history modal's) whole answer to
 * "what can this file show me". It leans on the engine's extension table rather than a list
 * of its own, so the cases below are about the *decisions* — markdown before category,
 * media before text for `svg`, binary for everything else.
 */
describe("previewKindOf", () => {
  it("renders markdown, in either spelling", () => {
    expect(previewKindOf("note.md")).toBe("markdown");
    expect(previewKindOf("notes/deep/plan.markdown")).toBe("markdown");
  });

  it("shows every media category the engine knows as media", () => {
    for (const path of ["photo.png", "photo.jpg", "photo.jpeg", "photo.gif", "photo.webp"]) {
      expect(previewKindOf(path), path).toBe("image");
    }
    for (const path of ["clip.mp4", "clip.webm", "clip.mov", "clip.mkv", "clip.ogv"]) {
      expect(previewKindOf(path), path).toBe("video");
    }
    for (const path of ["sound.mp3", "sound.wav", "sound.ogg", "sound.flac", "sound.m4a"]) {
      expect(previewKindOf(path), path).toBe("audio");
    }
    // `avif`/`bmp`/`svg` are images too, and `3gp` is the engine's one audio outlier.
    for (const path of ["photo.avif", "scan.bmp", "icon.svg", "clip.3gp"]) {
      expect(previewKindOf(path), path).not.toBe("binary");
    }
  });

  it("prefers the image over the text for an SVG", () => {
    // The engine calls SVG text (it is XML), but an Obsidian user wants the picture.
    expect(previewKindOf("icon.svg")).toBe("image");
  });

  it("shows the rest of the text formats as source", () => {
    for (const path of ["board.canvas", "vault.base", "data.json", "style.css", "notes.txt"]) {
      expect(previewKindOf(path), path).toBe("text");
    }
  });

  it("is binary for what has no preview, an unknown format, or no path at all", () => {
    for (const path of ["paper.pdf", "archive.zip", "plugin.js.map", "LICENSE", "photo.psd"]) {
      expect(previewKindOf(path), path).toBe("binary");
    }
    // A path that would not decrypt: the format is unknown, so nothing is guessed.
    expect(previewKindOf(null)).toBe("binary");
  });
});

describe("previewIconOf", () => {
  it("names one icon per preview kind, from the same decision the rendering uses", () => {
    // The recycle bin's row and the content dialog's header both read this, so a path
    // must not be an image in one and a text file in the other.
    expect(previewIconOf("note.md")).toBe("file-text");
    expect(previewIconOf("board.canvas")).toBe("file-code");
    expect(previewIconOf("data.json")).toBe("file-code");
    expect(previewIconOf("photo.png")).toBe("image");
    expect(previewIconOf("clip.mp4")).toBe("video");
    expect(previewIconOf("sound.mp3")).toBe("music");
    expect(previewIconOf("paper.pdf")).toBe("file");
    // No path at all is "binary": even an unknown format gets a deliberate icon.
    expect(previewIconOf(null)).toBe("file");
  });
});

describe("mimeTypeFor", () => {
  it("names a type for every extension the media categories hold", () => {
    // The lists mirror the engine's table (`file-types.ts`); a category whose extensions
    // had no type would hand Chromium a typeless blob to guess at.
    const media = [
      "avif",
      "bmp",
      "gif",
      "jpeg",
      "jpg",
      "png",
      "svg",
      "webp",
      "mkv",
      "mov",
      "mp4",
      "ogv",
      "webm",
      "3gp",
      "flac",
      "m4a",
      "mp3",
      "ogg",
      "wav",
    ];
    for (const extension of media) {
      const mime = mimeTypeFor(`file.${extension}`);
      expect(mime, extension).not.toBe("application/octet-stream");
      expect(mime, extension).toMatch(/^(image|video|audio)\//);
    }
  });

  it("falls back to the generic type for anything else", () => {
    expect(mimeTypeFor("note.md")).toBe("application/octet-stream");
    expect(mimeTypeFor("paper.pdf")).toBe("application/octet-stream");
    expect(mimeTypeFor("LICENSE")).toBe("application/octet-stream");
  });
});

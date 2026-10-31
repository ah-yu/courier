import { extensionOf, fileTypeOf, isTextPreviewPath } from "@courier/engine";

/**
 * How a stored version's decrypted bytes should be shown.
 *
 * One rule for every surface that previews content — the recycle bin's deleted
 * version and the version-history modal — because "what is this file" is the
 * engine's extension table (`fileTypeOf`), not a second list kept here:
 *
 * - `markdown` — rendered by Obsidian's own renderer, so wiki links, embeds and
 *   callouts look the way they do in a note.
 * - `text` — the decrypted source, monospace. Everything the engine calls text
 *   (canvas, json, css, …) that is not markdown.
 * - `image` / `video` / `audio` — played inline from a blob URL.
 * - `binary` — nothing sensible to show (`pdf`, archives, plugin bundles) or a path
 *   that would not decrypt, so the dialog says what it is instead of rendering
 *   replacement characters.
 *
 * `svg` is XML text *and* an image; the image wins, the same way `.webm` is video
 * rather than audio in the engine's table.
 */
export type FilePreviewKind = "markdown" | "text" | "image" | "video" | "audio" | "binary";

/** Extensions Obsidian renders as a note, whatever the engine's category says. */
const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(["md", "markdown"]);

/**
 * Which preview a path gets. `null` (a path that would not decrypt) is `binary`:
 * the format is unknown, and guessing text would show mojibake for a PNG.
 *
 * A PDF is deliberately `binary` rather than an inline viewer: Obsidian renders PDFs
 * with its own pdf.js view, which needs a file in the vault — a deleted version has
 * none, and the platform's `<embed>` viewer is unavailable in this renderer.
 */
export function previewKindOf(path: string | null): FilePreviewKind {
  if (!path) return "binary";

  const extension = extensionOf(path);
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";

  switch (fileTypeOf(path)) {
    case "images":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    default:
      break;
  }

  return isTextPreviewPath(path) ? "text" : "binary";
}

/**
 * The icon that names a preview kind.
 *
 * One table for the two surfaces that put an icon on a path — the recycle bin's row
 * and the content dialog's header — so the two can never disagree about what a file
 * is (`previewKindOf` is decided by the engine's table, not by the extension's name).
 */
const PREVIEW_ICONS: Record<FilePreviewKind, string> = {
  markdown: "file-text",
  text: "file-code",
  image: "image",
  video: "video",
  audio: "music",
  binary: "file",
};

/** The icon for a path's preview kind; no path is "binary", so it gets the generic file. */
export function previewIconOf(path: string | null): string {
  return PREVIEW_ICONS[previewKindOf(path)];
}

/**
 * The MIME type a blob URL needs for the media elements to play it.
 *
 * Chromium sniffs most containers, but a `Blob` without a type makes some of them
 * refuse outright, and the pairing with the engine's table is what keeps a preview
 * from disagreeing with what the file is. An unknown extension falls back to the
 * generic type rather than guessing a category.
 */
const MIME_TYPES: Readonly<Record<string, string>> = {
  // images
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  // video
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp4: "video/mp4",
  ogv: "video/ogg",
  webm: "video/webm",
  // audio
  "3gp": "audio/3gpp",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
};

/** The `type` for a preview blob, or the generic one for an unlisted extension. */
export function mimeTypeFor(path: string): string {
  return MIME_TYPES[extensionOf(path)] ?? "application/octet-stream";
}

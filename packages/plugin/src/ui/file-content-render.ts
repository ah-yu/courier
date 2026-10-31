import { Component, MarkdownRenderer, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import { mimeTypeFor, previewKindOf } from "../shared/file-preview";

/**
 * A stored version's decrypted bytes, drawn into an existing element.
 *
 * Two surfaces show the content of a version that is not a vault file: the recycle bin's
 * content dialog (the version a delete removed) and the version-history view's reading pane
 * (any version of a live chain). The question is the same on both — "what is in this
 * version" — so the answer is drawn once here, and only the frame around it differs: the
 * dialog supplies a card with its own padding and scroll, the view supplies its pane body.
 *
 * What the bytes *are* is `previewKindOf`'s answer (Obsidian's own extension table):
 * markdown goes through `MarkdownRenderer.render`, other text is monospace source, images
 * and audio/video play from a blob URL, and everything else says what it is instead of
 * showing replacement characters.
 */
export interface FileContentRenderOptions {
  app: App;
  /** Where the content is drawn. The caller owns the frame, the padding and the scroll. */
  container: HTMLElement;
  /** The path the bytes belong to: decides the preview and resolves internal links. */
  path: string;
  bytes: Uint8Array;
  /**
   * The lifecycle owner of whatever the renderer spawns (a markdown embed, a blob URL).
   *
   * The view re-renders on every selection, so it hands a fresh `Component` to each render
   * and unloads the previous one: a `blob:` URL is revoked when its owner unloads, which is
   * what keeps a walk through ten image versions from holding ten videos in memory.
   */
  owner: Component;
}

/** Draw one version's bytes into `options.container`. */
export async function renderFileContent(options: FileContentRenderOptions): Promise<void> {
  const { container, path, bytes } = options;
  const kind = previewKindOf(path);

  // An empty file gets a deliberate state rather than an empty card — except a binary one,
  // where "0 bytes" is still "cannot preview this".
  if (bytes.byteLength === 0 && kind !== "binary") {
    renderEmpty(container);
    return;
  }

  switch (kind) {
    case "markdown":
      await renderMarkdown(options);
      break;
    case "text":
      renderText(container, bytes);
      break;
    case "image":
      renderMedia(options, "img");
      break;
    case "video":
      renderMedia(options, "video");
      break;
    case "audio":
      renderMedia(options, "audio");
      break;
    default:
      renderBinary(container);
  }
}

/** An empty file still gets a deliberate state, not an empty card. */
function renderEmpty(container: HTMLElement): void {
  const empty = container.createDiv({ cls: "courier-file-preview-empty" });
  const icon = empty.createDiv({ cls: "courier-file-preview-empty-icon" });
  setIcon(icon, "file");
  empty.createDiv({
    cls: "courier-file-preview-empty-title",
    text: t("dialog.fileContent.emptyTitle"),
  });
  empty.createDiv({
    cls: "courier-file-preview-empty-desc",
    text: t("dialog.fileContent.emptyDesc"),
  });
}

/** What cannot be previewed says so, with the reason rather than replacement chars. */
function renderBinary(container: HTMLElement): void {
  const placeholder = container.createDiv({ cls: "courier-file-preview-placeholder" });
  const icon = placeholder.createDiv({ cls: "courier-file-preview-placeholder-icon" });
  setIcon(icon, "file");
  placeholder.createDiv({
    cls: "courier-file-preview-placeholder-title",
    text: t("dialog.fileContent.binaryTitle"),
  });
  placeholder.createDiv({
    cls: "courier-file-preview-placeholder-desc",
    text: t("dialog.fileContent.binaryDesc"),
  });
}

/** Obsidian's own markdown rendering — the same output a preview tab shows. */
async function renderMarkdown(options: FileContentRenderOptions): Promise<void> {
  const { app, container, path, bytes, owner } = options;
  const target = container.createDiv({
    cls: "courier-file-preview-markdown markdown-rendered",
  });
  // No horizontal padding: the renderer's own block styles already carry the rhythm, and
  // the frame's padding is what the rest of the surface aligns to.
  await MarkdownRenderer.render(app, new TextDecoder().decode(bytes), target, path, owner);
}

/** Decrypted source for a text format that is not markdown. */
function renderText(container: HTMLElement, bytes: Uint8Array): void {
  const pre = container.createEl("pre", { cls: "courier-file-preview-text" });
  pre.setText(new TextDecoder().decode(bytes));
}

/**
 * An image, a video or an audio track, from the decrypted bytes.
 *
 * A blob URL rather than a `data:` one: base64 would inflate a 50 MiB video by a third and
 * build the whole string in memory first. The URL is revoked when `owner` unloads.
 */
function renderMedia(options: FileContentRenderOptions, tag: "img" | "video" | "audio"): void {
  const { container, path } = options;
  const url = createObjectUrl(options);
  if (url === null) {
    const placeholder = container.createDiv({ cls: "courier-file-preview-placeholder" });
    const icon = placeholder.createDiv({ cls: "courier-file-preview-placeholder-icon" });
    setIcon(icon, "alert-circle");
    placeholder.createDiv({
      cls: "courier-file-preview-placeholder-title",
      text: t("dialog.fileContent.mediaTitle"),
    });
    placeholder.createDiv({
      cls: "courier-file-preview-placeholder-desc",
      text: t("dialog.fileContent.mediaDesc"),
    });
    return;
  }

  // The frame can give the player a quieter surface than a note's text does.
  container.addClass("is-media");

  if (tag === "img") {
    const image = container.createEl("img", { cls: "courier-file-preview-image" });
    image.src = url;
    image.alt = path;
    return;
  }

  if (tag === "video") {
    const video = container.createEl("video", { cls: "courier-file-preview-video" });
    video.controls = true;
    video.src = url;
    return;
  }

  const audio = container.createEl("audio", { cls: "courier-file-preview-audio" });
  audio.controls = true;
  audio.src = url;
}

function createObjectUrl(options: FileContentRenderOptions): string | null {
  if (typeof URL?.createObjectURL !== "function") return null;
  // A fresh `Uint8Array` over its own `ArrayBuffer`: the decrypted bytes arrive as a view
  // whose buffer type is not narrowable to `ArrayBuffer` for a `Blob` part, and a `Blob`
  // copies what it is given in any case.
  const bytes = new Uint8Array(options.bytes.byteLength);
  bytes.set(options.bytes);
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeTypeFor(options.path) }));
  options.owner.register(() => URL.revokeObjectURL(url));
  return url;
}

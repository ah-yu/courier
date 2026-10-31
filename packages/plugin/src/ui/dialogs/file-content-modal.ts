import { Component, Modal, setIcon, type App } from "obsidian";
import { t, type PluginMessageKey } from "../../i18n";
import { previewIconOf, previewKindOf, type FilePreviewKind } from "../../shared/file-preview";
import { renderFileContent } from "../file-content-render";

/** What one stored version's content looks like in a dialog. */
export interface FileContentPreview {
  /**
   * The dialog's title — deliberately **not** the path.
   *
   * Obsidian renders a modal title on one line and ellipsises it, so a path there is a
   * truncated path; the path belongs in the body, where it can wrap.
   */
  title: string;
  /** What the content belongs to: the path it was written at, or a version's identity. */
  subject: string;
  /** The muted facts line under it — when, by which device, how big. */
  facts: string[];
  /** The path the bytes belong to: it decides the preview and resolves internal links. */
  path: string;
  /** The decrypted bytes. */
  bytes: Uint8Array;
}

/** The catalog key of the short label beside the subject. */
const PREVIEW_KIND_KEYS: Record<FilePreviewKind, PluginMessageKey> = {
  markdown: "dialog.fileContent.kind.markdown",
  text: "dialog.fileContent.kind.text",
  image: "dialog.fileContent.kind.image",
  video: "dialog.fileContent.kind.video",
  audio: "dialog.fileContent.kind.audio",
  binary: "dialog.fileContent.kind.binary",
};

/**
 * A stored file version's content, previewed.
 *
 * The dialog is the header (file-type icon, subject, facts, kind label) plus one card that
 * scrolls; the bytes inside the card are drawn by `renderFileContent`, which is the same
 * renderer the version-history view uses for its reading pane. That split is what makes a
 * version read identically in the dialog and in the view: the dialog owns the frame, the
 * renderer owns the content.
 *
 * The one thing the frame adds is the `Component` the markdown renderer and the media
 * players need: a dialog is not declared as a `Component` in the API's typings, so it owns
 * one and unloads it on close.
 */
export class FileContentModal extends Modal {
  private readonly component = new Component();

  constructor(
    app: App,
    private readonly preview: FileContentPreview,
  ) {
    super(app);
  }

  override async onOpen(): Promise<void> {
    this.component.load();
    this.setTitle(this.preview.title);
    this.modalEl.addClass("courier-file-preview-modal");

    this.renderHeader();

    // The card itself: its padding is what the rendered note and the media centre in,
    // and `max-height` in CSS is what makes it — not the dialog — scroll.
    const body = this.contentEl.createDiv({ cls: "courier-file-preview" });
    await renderFileContent({
      app: this.app,
      container: body,
      path: this.preview.path,
      bytes: this.preview.bytes,
      owner: this.component,
    });
  }

  override onClose(): void {
    this.component.unload();
    this.contentEl.empty();
  }

  /**
   * The file-type icon, the subject and the facts under it.
   *
   * The subject wraps (`word-break`) because it is usually a path, and a path that is cut
   * off is the one thing this header exists to avoid. The kind label gives the dialog a
   * second, immediate answer besides the rendering below it.
   */
  private renderHeader(): void {
    const kind = previewKindOf(this.preview.path);
    const header = this.contentEl.createDiv({ cls: "courier-file-preview-header" });

    const icon = header.createDiv({ cls: "courier-file-preview-icon" });
    setIcon(icon, previewIconOf(this.preview.path));

    const heading = header.createDiv({ cls: "courier-file-preview-heading" });
    heading.createDiv({
      text: this.preview.subject,
      cls: "courier-file-preview-subject",
    });

    const facts = this.preview.facts.filter((fact) => fact.length > 0).join(" · ");
    if (facts) {
      heading.createDiv({ text: facts, cls: "courier-file-preview-facts" });
    }

    header.createSpan({ cls: "courier-file-preview-kind", text: t(PREVIEW_KIND_KEYS[kind]) });
  }
}

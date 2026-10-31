import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";

/**
 * Message-only modal, with an optional action button next to "OK".
 *
 * The dialogs produce small "here is what happened, here is what to do about it"
 * steps (a failure, or a pointer at the surface that owns the decision). Sharing
 * one modal keeps those messages consistent and lets a test drive them like any
 * other dialog.
 */
export class MessageModal extends Modal {
  constructor(
    app: App,
    private readonly text: string,
    private readonly action?: { label: string; onClick: () => void },
  ) {
    super(app);
  }

  override onOpen(): void {
    this.contentEl.createEl("p", { text: this.text });

    const setting = new Setting(this.contentEl);
    if (this.action) {
      setting.addButton((button) =>
        button.setButtonText(this.action!.label).onClick(() => {
          this.action!.onClick();
          this.close();
        }),
      );
    }
    setting.addButton((button) =>
      button
        .setCta()
        .setButtonText(t("common.ok"))
        .onClick(() => this.close()),
    );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

import { Setting } from "obsidian";
import { t } from "../../i18n";
import { PromiseModal } from "./promise-modal";

export interface CreateVaultModalResult {
  name: string;
  password: string;
}

/**
 * Modal dialog for creating a new remote vault.
 * Collects vault name and password from the user.
 */
export class CreateVaultModal extends PromiseModal<CreateVaultModalResult> {
  private name = "";
  private password = "";
  /** The inline error line, so a missing field does not close over into a toast. */
  private errorEl: HTMLElement | null = null;

  override onOpen(): void {
    const { contentEl } = this;
    this.setTitle(t("dialog.createVault.title"));

    // Vault name input
    new Setting(contentEl)
      .setName(t("dialog.createVault.name"))
      .setDesc(t("dialog.createVault.nameDesc"))
      .addText((text) =>
        text.setPlaceholder(t("dialog.createVault.namePlaceholder")).onChange((value) => {
          this.name = value;
          this.clearError();
        }),
      );

    // Password input (masked)
    new Setting(contentEl)
      .setName(t("dialog.createVault.password"))
      .setDesc(t("dialog.createVault.passwordDesc"))
      .addText((text) => {
        text.setPlaceholder(t("dialog.createVault.passwordPlaceholder"));
        text.inputEl.type = "password";
        text.onChange((value) => {
          this.password = value;
          this.clearError();
        });
      });

    // Always present, so validation reads under the fields rather than as a toast.
    this.errorEl = contentEl.createDiv({ cls: "courier-setup-error" });

    // Action buttons
    new Setting(contentEl)
      .addButton((button) => button.setButtonText(t("common.cancel")).onClick(() => this.cancel()))
      .addButton((button) =>
        button
          .setButtonText(t("dialog.createVault.create"))
          .setCta()
          .onClick(() => this.submit()),
      );
  }

  /** The dialog's one submission path: both fields are checked before anything is created. */
  private submit(): void {
    if (!this.name.trim()) {
      this.showError(t("dialog.createVault.nameRequired"));
      return;
    }
    if (!this.password) {
      this.showError(t("dialog.createVault.passwordRequired"));
      return;
    }
    this.resolve({
      name: this.name.trim(),
      password: this.password,
    });
  }

  private showError(message: string): void {
    if (!this.errorEl) return;
    this.errorEl.setText(message);
    this.errorEl.addClass("is-visible");
  }

  private clearError(): void {
    this.errorEl?.removeClass("is-visible");
  }
}

import { App, Setting } from "obsidian";
import { t } from "../../i18n";
import { PromiseModal } from "./promise-modal";

export interface PasswordPromptResult {
  password: string;
  /**
   * Whether the derived vault key should be kept on this device, so reopening
   * Obsidian unlocks automatically instead of asking again. Always false when
   * the dialog was opened without {@link PasswordPromptOptions.askToRemember}.
   */
  remember: boolean;
}

export interface PasswordPromptOptions {
  /**
   * Offer the "remember on this device" toggle. The default (true) is the
   * unlock path, where keeping the key is the point. Callers that only need to
   * confirm the password — deleting a remote vault — pass false, because there
   * is nothing to remember in that flow.
   */
  askToRemember?: boolean;
  /**
   * What the dialog is about, when it is opened for one specific action: the
   * settings page connects to a vault the user picked, so the title can name it
   * instead of reading as a generic unlock prompt.
   */
  title?: string;
  /** Label of the confirming button (`Unlock` by default). */
  confirmLabel?: string;
}

/**
 * The dialog for a vault password, used by two flows:
 *
 *   - **Unlock** (plugin load, when no usable key is stored on this device, and
 *     the settings page's locked stage): asks for the password so the AES key can
 *     be derived and the sync host can start, offering to keep the key here. The
 *     unlock flows share one dialog (`CourierPlugin.askForVaultPassword`), so a load
 *     and a settings click cannot ask the same question twice.
 *   - **Confirm before deleting a remote vault**: the password is verified
 *     against the server's canary locally, so a destructive action cannot be
 *     triggered by someone who does not know it. The picker constructs this one
 *     itself — it is not an unlock, so it does not join the unlock slot.
 *
 * Connecting to a vault is not one of them: the picker collects the password with
 * the per-vault device label and exclusions in {@link SetupConnectionModal}.
 *
 * The password itself is never persisted: when {@link PasswordPromptResult.remember}
 * is set, the caller stores the **derived key** in Obsidian's App-level
 * localStorage (`shared/credential-store.ts`) — device-scoped, outside the
 * vault, and disposable from the plugin's settings tab.
 */
export class PasswordPromptModal extends PromiseModal<PasswordPromptResult | null> {
  private password = "";
  private remember: boolean;
  private readonly askToRemember: boolean;
  private readonly titleText: string;
  private readonly confirmLabel: string;
  /** The inline error line, created once in `onOpen` and toggled from `submit`. */
  private errorEl: HTMLElement | null = null;

  constructor(app: App, options: PasswordPromptOptions = {}) {
    super(app);
    this.askToRemember = options.askToRemember ?? true;
    this.titleText = options.title ?? t("dialog.password.title");
    this.confirmLabel = options.confirmLabel ?? t("dialog.password.unlock");
    // Remembering the key is the default: it is what stops every start from
    // asking again.
    this.remember = this.askToRemember;
  }

  override onOpen(): void {
    const { contentEl } = this;
    // The rows below pair a one-line label with a taller field, and a two-line explanation
    // with a switch: the stylesheet puts both halves of a row on one line (`align-items`).
    contentEl.addClass("courier-password-prompt");
    this.setTitle(this.titleText);

    contentEl.createEl("p", {
      text: t("dialog.password.intro"),
    });

    new Setting(contentEl).setName(t("dialog.password.label")).addText((text) => {
      text.setPlaceholder(t("dialog.password.placeholder"));
      text.inputEl.type = "password";
      text.onChange((value) => {
        this.password = value;
        this.clearError();
      });
      // Submit on Enter
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") this.submit();
      });
    });

    // Always present, so a validation error appears under the field instead of as a toast
    // that leaves the dialog open with nothing explaining it.
    this.errorEl = contentEl.createDiv({ cls: "courier-setup-error" });

    if (this.askToRemember) {
      new Setting(contentEl)
        .setName(t("dialog.password.remember"))
        .setDesc(t("dialog.password.rememberDesc"))
        .addToggle((toggle) => {
          toggle.setValue(this.remember).onChange((value) => {
            this.remember = value;
          });
        });
    }

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText(t("common.cancel")).onClick(() => {
          this.cancel();
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText(this.confirmLabel)
          .setCta()
          .onClick(() => this.submit()),
      );
  }

  /** The dialog's one submission path: the button and Enter must validate the same way. */
  private submit(): void {
    if (!this.password) {
      this.showError(t("dialog.password.required"));
      return;
    }
    this.resolve({ password: this.password, remember: this.remember });
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

import { App, Setting } from "obsidian";
import type { ListVaultsResponse } from "@courier/shared";
import { t } from "../../i18n";
import { PromiseModal } from "./promise-modal";
import { PasswordPromptModal } from "./password-prompt-modal";
import { SetupConnectionModal } from "./setup-connection-modal";
import { CreateVaultModal } from "./create-vault-modal";
import { describeActionError, type ActionOutcome } from "../../shared/action-error";
import { createdAgoLabel } from "../../shared/relative-time";
import type { ListVaultsAction } from "../../shared/api";
import type { VaultConnectionSetup } from "../../shared/settings";
import type { VaultCredentialCheck } from "../../shared/vault-credentials";

type VaultSummary = ListVaultsResponse["vaults"][number];

/**
 * What the picker needs from the plugin.
 *
 * Declared here rather than importing the plugin class, so this module stays a leaf
 * (the settings page owns the plugin and passes itself in, which type-checks
 * structurally). Every mutating call answers an `ActionOutcome` — the picker shows
 * the sentence under the list and keeps the dialog open, so nothing the user did is
 * lost to a closed window.
 */
export interface VaultPickerHost {
  actions: { listVaults: ListVaultsAction };
  connectToVault(
    vaultId: string,
    vaultName: string,
    password: string,
    remember?: boolean,
    setup?: VaultConnectionSetup,
  ): Promise<ActionOutcome>;
  /**
   * What the connection dialog starts from for this vault, and whether this device has
   * already completed its setup. A vault configured with **no** excluded folders is still
   * `configured`; the same dialog opens either way, with a different lead line.
   */
  getConnectionSetup(vaultId: string): {
    configured: boolean;
    deviceName: string;
    excludedFolders: string[];
  };
  deleteVault(vaultId: string): Promise<ActionOutcome>;
  /**
   * Check a password against the vault's canary, answering **why** it was refused.
   *
   * A boolean could not tell a wrong password from an unreachable server, so the row
   * said "密码不正确" for both and a toast had to correct it.
   */
  fetchVaultCredentials(vaultId: string, password: string): Promise<VaultCredentialCheck>;
  createVault(name: string, password: string): Promise<ActionOutcome<{ id: string; name: string }>>;
}

/**
 * "Choose a remote vault" — the dialog behind the settings page's vault row.
 *
 * The list is the account's vaults, one row each, with how old each one is, the one
 * thing that can be done to it besides connecting (delete, as an icon) and connecting
 * as the row's action — plus an entry to create a new vault. The
 * page itself stays two rows long no matter how many vaults exist, which is why the
 * management lives here.
 *
 * Resolves `true` when a vault was connected (the caller re-renders: the page moves
 * on to the settings), and `null` when it was dismissed.
 */
export class VaultPickerModal extends PromiseModal<boolean> {
  private readonly host: VaultPickerHost;
  private listEl!: HTMLElement;
  private vaults: VaultSummary[] | null = null;
  private loading = false;
  /** The list could not be read at all — offered a retry. */
  private listError: string | null = null;
  /** The last connect/delete failed — shown above the list, which stays. */
  private actionError: string | null = null;

  constructor(app: App, host: VaultPickerHost) {
    super(app);
    this.host = host;
  }

  override onOpen(): void {
    this.setTitle(t("dialog.vaultPicker.title"));
    this.listEl = this.contentEl.createDiv({ cls: "courier-vault-list" });

    // One centred action under the list, like Obsidian's own vault picker: the dialog
    // is closed with its ✕, so there is no second button to explain. A settings row
    // lays its (empty) info area and its control out side by side and lets the info
    // grow, which pins the button to the right; stacking them centres it instead.
    const footer = new Setting(this.contentEl);
    this.addAction(footer, t("dialog.vaultPicker.create"), () => void this.create(), {
      cta: true,
    });
    footer.settingEl.style.cssText =
      "display: flex; flex-direction: column; align-items: center; border: none; padding: 6px 0 0; margin: 0;";
    // The phone layout gives the control the row's full width and pushes its content to
    // the right; the dialog's one entry point sits in the middle on every platform.
    const control = footer.settingEl.querySelector<HTMLElement>(".setting-item-control");
    if (control) control.style.cssText = "justify-content: center;";

    void this.load();
  }

  /**
   * Add one of the dialog's buttons.
   *
   * Obsidian's phone layout stretches a settings row's control to the row's full width,
   * which turns a list of vaults into a stack of full-width buttons (and its modal
   * buttons are full width anyway). These are actions on a line, not the row's own
   * control, so they keep their content width on every platform.
   */
  private addAction(
    setting: Setting,
    label: string,
    onClick: () => void,
    options: { cta?: boolean } = {},
  ): void {
    setting.addButton((button) => {
      button.setButtonText(label).onClick(onClick);
      if (options.cta) button.setCta();
      button.buttonEl.style.cssText = "flex: 0 0 auto; width: auto;";
    });
  }

  /** Read the vault list and paint it. */
  private async load(): Promise<void> {
    this.loading = true;
    this.listError = null;
    this.paint();
    try {
      const response = await this.host.actions.listVaults();
      this.vaults = response.vaults;
    } catch (err) {
      console.error("Listing remote vaults failed:", err);
      this.listError = describeActionError(err, t("action.loadVaults"));
      this.vaults = null;
    } finally {
      this.loading = false;
      this.paint();
    }
  }

  /** Repaint the list region — the only part of the dialog that changes. */
  private paint(): void {
    this.listEl.empty();

    if (this.actionError) {
      const error = this.listEl.createDiv({ cls: "courier-settings-error" });
      error.style.cssText = "color: var(--text-error); margin-bottom: 8px;";
      error.setText(`⚠ ${this.actionError}`);
    }

    if (this.loading) {
      this.listEl.createEl("p", { text: t("dialog.vaultPicker.loading") });
      return;
    }
    if (this.listError) {
      const error = this.listEl.createEl("p", {
        text: `⚠ ${this.listError}`,
        cls: "courier-settings-error",
      });
      error.style.cssText = "color: var(--text-error);";
      new Setting(this.listEl).addButton((button) =>
        button.setButtonText(t("common.retry")).onClick(() => void this.load()),
      );
      return;
    }

    const vaults = this.vaults ?? [];
    if (vaults.length === 0) {
      this.listEl.createEl("p", { text: t("dialog.vaultPicker.empty") });
      return;
    }

    for (const vault of vaults) {
      // One row per vault: its name and how old it is on one line (the age is the only
      // thing that tells two same-named vaults apart), deleting as an icon button, and
      // connecting as the row's action.
      const row = new Setting(this.listEl)
        .setName(vault.name)
        .setDesc(createdAgoLabel(vault.createdAt))
        .addExtraButton((button) =>
          button
            .setIcon("x")
            .setTooltip(t("dialog.vaultPicker.deleteTooltip"))
            .onClick(async () => {
              await this.remove(vault);
            }),
        );
      this.addAction(row, t("dialog.vaultPicker.connect"), () => this.connect(vault), {
        cta: true,
      });

      // A settings row stacks its name over its description, draws a rule above itself
      // and pads like a settings page; a picker is a list, so its rows are one tight line
      // each with no rules at all — on the phone layout too, which would otherwise stack
      // the row and stretch its control across the whole width. The row itself never
      // wraps (the buttons stay beside the name); when the line is too narrow for the
      // name and its age, the *age* drops to a second line inside the row's own text.
      row.settingEl.style.cssText =
        "display: flex; flex-direction: row; flex-wrap: nowrap; align-items: center; " +
        "justify-content: space-between; gap: 8px; border: none; padding: 3px 0; margin: 0;";
      const info = row.settingEl.querySelector<HTMLElement>(".setting-item-info");
      if (info) {
        info.style.cssText =
          "display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; " +
          "flex: 1 1 auto; min-width: 0;";
      }
      const control = row.settingEl.querySelector<HTMLElement>(".setting-item-control");
      if (control) {
        // `width` as well as `flex`: the phone layout gives a row's control the whole row
        // width, which wins over a flex shorthand alone.
        control.style.cssText = "flex: 0 0 auto; width: auto; justify-content: flex-end; gap: 8px;";
      }
    }
  }

  /**
   * Connect one vault.
   *
   * Every connect opens the `Setup connection` dialog. A first connection starts from the
   * current label and no exclusions; a returning vault starts from its saved record, so the
   * same form doubles as the confirmation of those values. The dialog owns the connect
   * action, so a failure keeps everything the user typed.
   */
  private connect(vault: VaultSummary): void {
    const setup = this.host.getConnectionSetup(vault.id);
    this.actionError = null;
    new SetupConnectionModal(this.app, {
      vaultName: vault.name,
      deviceName: setup.deviceName,
      excludedFolders: setup.excludedFolders,
      configured: setup.configured,
      onSubmit: (values) =>
        this.host.connectToVault(vault.id, vault.name, values.password, values.remember, {
          deviceName: values.deviceName,
          excludedFolders: values.excludedFolders,
        }),
      onConnected: () => this.resolve(true),
    }).open();
  }

  /**
   * Create a remote vault. Creating is not connecting: the dialog stays open and
   * re-reads the list, so the new vault appears among the others and the user decides
   * when to connect to it.
   */
  private async create(): Promise<void> {
    const modal = new CreateVaultModal(this.app);
    modal.open();
    const result = await modal.getResult();
    if (!result) return;

    this.actionError = null;
    const outcome = await this.host.createVault(result.name, result.password);
    if (!outcome.ok) {
      this.actionError = outcome.error;
      this.paint();
      return;
    }
    await this.load();
  }

  private async remove(vault: VaultSummary): Promise<void> {
    // Verify the vault password locally before deleting (防误删). No "remember"
    // toggle here: this dialog only confirms the password, it does not unlock.
    const pwModal = new PasswordPromptModal(this.app, {
      askToRemember: false,
      title: t("dialog.vaultPicker.deleteTitle", { vault: vault.name }),
      confirmLabel: t("dialog.vaultPicker.confirmOk"),
    });
    pwModal.open();
    const pw = await pwModal.getResult();
    if (!pw) return;

    const check = await this.host.fetchVaultCredentials(vault.id, pw.password);
    if (check.kind === "error") {
      // Not a wrong password: the check never got an answer, and saying "密码不正确"
      // here would send the user hunting for a typo that is not there.
      this.actionError = describeActionError(check.error, t("action.verifyVaultPassword"));
      this.paint();
      return;
    }
    if (check.kind === "invalid-password") {
      this.actionError = t("dialog.vaultPicker.wrongPassword");
      this.paint();
      return;
    }

    const confirm = await this.confirm(
      t("dialog.vaultPicker.deleteConfirm", { vault: vault.name }),
    );
    if (!confirm) return;

    this.actionError = null;
    const outcome = await this.host.deleteVault(vault.id);
    if (!outcome.ok) {
      this.actionError = outcome.error;
      this.paint();
      return;
    }
    // No confirmation toast: the picker reloads and the deleted row is simply gone.
    await this.load();
  }

  private async confirm(message: string): Promise<boolean> {
    const modal = new ConfirmModal(this.app, message);
    modal.open();
    const result = await modal.getResult();
    return result === true;
  }
}

/** Simple yes/no confirmation modal. */
class ConfirmModal extends PromiseModal<boolean> {
  constructor(
    app: App,
    private message: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    this.setTitle(t("dialog.vaultPicker.confirmTitle"));
    contentEl.createEl("p", { text: this.message });
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText(t("dialog.vaultPicker.confirmCancel")).onClick(() => this.resolve(false)),
      )
      .addButton((btn) =>
        btn
          .setButtonText(t("dialog.vaultPicker.confirmOk"))
          .setCta()
          .onClick(() => this.resolve(true)),
      );
  }
}

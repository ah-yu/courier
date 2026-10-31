import { clearVaultCredential, type CredentialStoreHost } from "./credential-store";
import { DEFAULT_SETTINGS, type CourierSettings } from "./settings";

/**
 * Letting go of a vault, in one place.
 *
 * Four flows do it — the user disconnects, the user logs out, the server says the vault is
 * gone, the server says the key is revoked — and each was written out by hand with its own
 * field list, so a field added later was cleared in two of the four. The difference between
 * them is one flag: logging out (or losing the key) also forgets the **account**.
 *
 * It takes the **narrow** host (`CredentialStoreHost`: the two localStorage methods the
 * credential store needs) rather than Obsidian's `App`, so the whole teardown is a unit
 * test with a fake store.
 *
 * What is deliberately kept in every case: the server URL, the active device label and the
 * per-vault connection records (`vaultConnections`). They are not credentials, and keeping
 * them is what makes logging back in one field instead of three and reconnecting a vault
 * skip the setup dialog.
 */
export interface SessionHost {
  /** The live settings record to clear. */
  settings: CourierSettings;
  /** Stop the engine host, if one is running. */
  stopHost(): void;
  /** Forget the in-memory vault key. */
  forgetKey(): void;
  /** Persist the cleared settings. */
  saveSettings(): Promise<void>;
}

export interface UnbindOptions {
  /**
   * Also forget the account: the user key, and the account name that belongs to it.
   *
   * `false` is "switch vault" — the key stays, so the vault picker is one click away.
   */
  forgetAccount?: boolean;
}

export async function unbindVault(
  app: CredentialStoreHost,
  host: SessionHost,
  options: UnbindOptions = {},
): Promise<void> {
  host.stopHost();
  // The device-local key goes with the binding: it is only meaningful for the vault it
  // was derived for, and keeping it would let a later connect silently reuse it.
  clearVaultCredential(app);

  host.settings.connectedVaultId = null;
  host.settings.connectedVaultName = null;
  host.settings.encryptionSalt = null;
  // Pausing belongs to the binding: there is nothing left to pause once it is gone, and
  // the next connection starts syncing.
  host.settings.syncPaused = false;
  host.settings.syncState = undefined;
  if (options.forgetAccount) {
    host.settings.userKey = null;
    // The account name belongs to the key that is going away.
    host.settings.userName = null;
    // The per-key file cap is the server's value for that same key, so the next
    // account starts from the default until its own read replaces it.
    host.settings.accountMaxFileBytes = DEFAULT_SETTINGS.accountMaxFileBytes;
  }

  host.forgetKey();
  await host.saveSettings();
}

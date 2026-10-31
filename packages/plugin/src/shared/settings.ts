import {
  DEFAULT_FILE_TYPES,
  DEFAULT_MAX_FILE_BYTES,
  NO_SETTINGS_GROUPS,
  normalizeExcludedFolders,
  normalizeScope,
  type FileTypeSync,
  type LocalVersionState,
  type SettingsSyncGroups,
  type SyncScope,
} from "@courier/engine";
import { DEFAULT_DEVICE_NAME, normalizeDeviceName } from "@courier/shared";

/** Re-export the engine's per-file sync state so the plugin stores the same shape. */
export type { LocalVersionState } from "@courier/engine";

/**
 * The scope this device syncs under, built from its settings and the vault's config
 * folder.
 *
 * One function rather than a `normalizeScope` call at each site. The host builds its
 * engine from this; the engine's activity events carry the scope decision at the moment
 * it was made, so the history UI no longer recomputes this from the current settings.
 */
export function syncScopeOf(settings: CourierSettings, configDir: string): SyncScope {
  return normalizeScope({
    configDir,
    settingsGroups: settings.settingsGroups,
    fileTypes: settings.fileTypes,
    excludedFolders: settings.excludedFolders,
    maxFileBytes: settings.accountMaxFileBytes,
  });
}

/**
 * The device-local connection settings of one remote vault.
 *
 * Both fields are per remote vault on purpose. The label is only display metadata — the
 * server keeps no device registry — but it belongs to the history of *that* vault, and a
 * folder exclusion is a vault-relative path. A record exists only after the connection
 * form was submitted for the vault, which is what lets a later connect open that form
 * prefilled with this vault's own values instead of starting from the defaults.
 */
export interface VaultConnectionSettings {
  /** The label this device states in that remote vault's sync history. */
  deviceName: string;
  /** Vault-relative folders this device leaves out of sync in that remote vault. */
  excludedFolders: string[];
}

/** The values the connection setup dialog submits for one remote vault. */
export interface VaultConnectionSetup {
  deviceName: string;
  excludedFolders: readonly string[];
}

/**
 * Persisted plugin settings.
 *
 * One unified settings shape is used on both desktop and mobile Obsidian. A
 * single user key (`ck_...`) authenticates the user across all of their
 * devices; `deviceName` is only a label this client states about itself in the
 * **connected** remote vault's history — each vault keeps its own value in
 * `vaultConnections`. Nothing is registered with the server and the name may be
 * changed at any time — a change affects the versions pushed afterwards, while
 * older history keeps the name it was written
 * with.
 */
export interface CourierSettings {
  /** Server REST base URL. Null → fall back to DEFAULT_SERVER_URL. */
  serverUrl: string | null;
  /** The single user key (`ck_...`) shared by all of the user's devices. */
  userKey: string | null;
  /**
   * The name of the account `userKey` belongs to, read once at sign-in
   * (`GET /api/me`) and kept only so the settings page can name the account it is
   * signed in as. Display metadata: the server owns the name, and a change there
   * shows up the next time the key is used to sign in.
   */
  userName: string | null;
  /**
   * The label this client states in the **currently connected** remote vault's history.
   *
   * A projection of `vaultConnections[connectedVaultId].deviceName`, kept top-level because
   * the engine host reads it on every push. A device may use a different label in each
   * remote vault; connecting a vault restores that vault's own value.
   */
  deviceName: string;
  connectedVaultId: string | null;
  connectedVaultName: string | null;
  /**
   * Whether this device has paused syncing the connected vault.
   *
   * Pausing is not disconnecting: the binding, the vault key (in memory or stored) and
   * the sync state all stay, so resuming needs no password on a device that remembers
   * one. It belongs to the binding, so connecting or unbinding clears it.
   */
  syncPaused: boolean;
  /** Base64 32-byte encryption salt of the connected vault. */
  encryptionSalt: string | null;
  /**
   * Which groups of Obsidian's config folder (`.obsidian`) this device syncs.
   *
   * Device-local on purpose: a peer that leaves a group off ignores those chains
   * entirely, so one device cannot change another's configuration without being
   * asked. Every group is off by default.
   */
  settingsGroups: SettingsSyncGroups;
  /**
   * Which vault-wide file types this device syncs, besides markdown and `.canvas`
   * (which always sync and have no switch). Images, audio, video and PDF are on by
   * default; every other file type is not.
   *
   * Device-local like the groups above: a type switched off here is neither pushed nor
   * pulled, and turning it off deletes nothing.
   */
  fileTypes: FileTypeSync;
  /**
   * Vault-relative folders the **currently connected** remote vault leaves out of sync.
   *
   * A projection of `vaultConnections[connectedVaultId].excludedFolders`. Device-local and
   * per remote vault: a path under one of these folders is neither pushed nor pulled, no
   * conflict copy is parked for it, and turning the exclusion off deletes nothing. Paths
   * inside Obsidian's config folder are not affected — those are the `settingsGroups`
   * switches.
   */
  excludedFolders: string[];
  /**
   * Per remote vault: the label this device states and the folders it leaves out of sync.
   *
   * A key exists only after the connection form was submitted for that vault (possibly with
   * an empty folder list), so its presence — never the list length — is what makes a later
   * connect open as a confirmation of the saved values rather than a first-time setup.
   * `deviceName` and `excludedFolders` above are the active projections of the connected
   * vault's entry.
   */
  vaultConnections: Record<string, VaultConnectionSettings>;
  /**
   * Largest plaintext file this account's key may sync, in bytes; `0` = no limit.
   *
   * Read from `GET /api/me` on every host start and cached here so an offline start and
   * the settings/history views still have a value. It is deliberately **not** a user
   * setting: the administrator sets it per key, there is no field or write path in the
   * plugin, and the next start overwrites whatever this file holds.
   */
  accountMaxFileBytes: number;
  /** Persisted per-file sync state (persisted by the engine host). */
  syncState?: {
    localVersions: LocalVersionState;
    /**
     * Whether a bind pass for this vault has ever completed on this device.
     *
     * Kept beside `localVersions`, never inside it: that map is keyed by fileId, so a
     * marker key there would be read as a chain. A bind killed after persisting part of
     * the vault leaves the map non-empty; this flag is what tells the next start that the
     * vault is still only half-bound (see `SyncHost.firstSync`).
     */
    bindCompleted?: boolean;
  };
}

export const DEFAULT_SETTINGS: CourierSettings = {
  serverUrl: null,
  userKey: null,
  userName: null,
  deviceName: DEFAULT_DEVICE_NAME,
  connectedVaultId: null,
  connectedVaultName: null,
  syncPaused: false,
  encryptionSalt: null,
  settingsGroups: NO_SETTINGS_GROUPS,
  fileTypes: DEFAULT_FILE_TYPES,
  excludedFolders: [],
  vaultConnections: {},
  accountMaxFileBytes: DEFAULT_MAX_FILE_BYTES,
};

// ── Per-vault connection records ──

/**
 * Normalize the persisted per-vault records.
 *
 * Every value is rebuilt through the shared normalizers, so a hand-edited `data.json` cannot
 * put an over-long device label or a `..` folder into a sync scope. An entry with an **empty**
 * folder list is deliberately kept: that is exactly the "setup completed, nothing excluded"
 * state the reconnect flow has to recognize.
 */
export function normalizeVaultConnections(raw: unknown): Record<string, VaultConnectionSettings> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};

  const normalized: Record<string, VaultConnectionSettings> = {};
  for (const [vaultId, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = vaultId.trim();
    if (!id) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    normalized[id] = {
      deviceName: normalizeDeviceName(
        typeof entry.deviceName === "string" ? entry.deviceName : undefined,
        DEFAULT_SETTINGS.deviceName,
      ),
      excludedFolders: normalizeExcludedFolders(entry.excludedFolders),
    };
  }
  return normalized;
}

/** Whether this device has completed the connection setup for `vaultId`. */
export function vaultHasSetup(settings: CourierSettings, vaultId: string): boolean {
  return Object.prototype.hasOwnProperty.call(settings.vaultConnections, vaultId);
}

/**
 * What this device would use for `vaultId`, whether or not a record exists.
 *
 * A vault this device has not configured yet answers the current active label and an empty
 * folder list: the setup dialog is the only caller of the "no record" branch, and those are
 * the values it starts from. Saving them is what creates the record.
 */
export function connectionSettingsForVault(
  settings: CourierSettings,
  vaultId: string,
): VaultConnectionSettings {
  const stored = settings.vaultConnections[vaultId];
  if (stored) {
    return {
      deviceName: normalizeDeviceName(stored.deviceName, DEFAULT_SETTINGS.deviceName),
      excludedFolders: normalizeExcludedFolders(stored.excludedFolders),
    };
  }
  return {
    deviceName: normalizeDeviceName(settings.deviceName, DEFAULT_SETTINGS.deviceName),
    excludedFolders: [],
  };
}

/** Write (or replace) one vault's record. An empty folder list is a valid record. */
export function setVaultConnection(
  settings: CourierSettings,
  vaultId: string,
  connection: VaultConnectionSettings,
): void {
  settings.vaultConnections[vaultId] = {
    deviceName: normalizeDeviceName(connection.deviceName, DEFAULT_SETTINGS.deviceName),
    excludedFolders: normalizeExcludedFolders(connection.excludedFolders),
  };
}

/**
 * Patch one field of a vault's record, creating the record when it does not exist.
 *
 * A first edit made on an already-bound vault (an upgrade, or a value seeded by a test) must
 * base the new record on the **active** label/folders, not on the empty defaults — otherwise
 * renaming the device would silently forget the exclusions the vault is currently using.
 */
export function updateVaultConnection(
  settings: CourierSettings,
  vaultId: string,
  patch: Partial<VaultConnectionSettings>,
): void {
  const existing = settings.vaultConnections[vaultId];
  const base: VaultConnectionSettings = existing
    ? {
        deviceName: normalizeDeviceName(existing.deviceName, DEFAULT_SETTINGS.deviceName),
        excludedFolders: normalizeExcludedFolders(existing.excludedFolders),
      }
    : {
        deviceName: settings.deviceName,
        excludedFolders: settings.excludedFolders,
      };
  setVaultConnection(settings, vaultId, { ...base, ...patch });
}

/** Forget a vault's record. Only a deleted remote vault should call this. */
export function forgetVaultConnection(settings: CourierSettings, vaultId: string): void {
  delete settings.vaultConnections[vaultId];
}

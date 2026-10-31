import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import type { CliVault } from "./config";

/**
 * What Obsidian and its Courier plugin are doing with this vault, for reporting only.
 *
 * A vault can have two clients: the Obsidian plugin, which only exists while Obsidian has
 * the vault open, and the CLI. The **per-vault lease** (`lease.ts`) decides which one may
 * build an engine; first come, first served. This module just reads `obsidian.json` (is
 * the vault open?) and the plugin's `data.json` (is it enabled, bound and unpaused?) so
 * `status` and a supervisor's page can explain why a lock is held or why a plugin will not
 * start while the CLI owns it.
 */
export interface Coexistence {
  /** Obsidian reports this exact vault as open. */
  obsidianOpen: boolean;
  /** The Courier plugin is enabled *and* bound to a vault, not paused. */
  pluginSyncActive: boolean;
  /**
   * A human-facing classification. It is **observation only**: whether this process
   * syncs is decided by the vault lease, not by this field.
   */
  reason: "no-vault" | "obsidian-closed" | "obsidian-plugin" | "obsidian-plugin-off";
}

/** Where Obsidian keeps its registry of vaults, per platform. */
export function obsidianConfigPath(env: Record<string, string | undefined> = process.env): string {
  // A test or a portable install can point at the file directly.
  if (env.COURIER_OBSIDIAN_JSON) return env.COURIER_OBSIDIAN_JSON;
  if (process.platform === "win32") {
    return path.join(
      env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"),
      "obsidian",
      "obsidian.json",
    );
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json");
  }
  const config = env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
  return path.join(config, "obsidian", "obsidian.json");
}

function readJSON(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/** One path in the form the comparison uses: forward slashes, no trailing slash, platform case. */
function normalizeVaultPath(value: string): string {
  let resolved = path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32" || process.platform === "darwin") {
    resolved = resolved.toLowerCase();
  }
  return resolved;
}

/** Compare two vault paths the way the platform does: case-insensitively on Windows and macOS. */
export function sameVaultPath(left: string, right: string): boolean {
  return normalizeVaultPath(left) === normalizeVaultPath(right);
}

/**
 * Whether one `obsidian.json` document says the vault is open.
 *
 * Exported as a pure function so the path matching and the `open` flag are testable
 * without an Obsidian installation.
 */
export function vaultOpenInRegistry(raw: unknown, vaultPath: string): boolean {
  if (!raw || typeof raw !== "object") return false;
  const vaults = (raw as { vaults?: unknown }).vaults;
  if (!vaults || typeof vaults !== "object") return false;
  for (const entry of Object.values(vaults as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { path?: unknown; open?: unknown };
    if (typeof record.path !== "string") continue;
    if (record.open === true && sameVaultPath(record.path, vaultPath)) return true;
  }
  return false;
}

/**
 * Whether the plugin would sync a vault, from what it persisted.
 *
 * The plugin stores its whole state in `data.json`; three fields matter here:
 * `userKey` (signed in), `connectedVaultId` (a vault is bound) and `syncPaused` (the
 * user deliberately stopped it). The remote vault id is **not** compared with the CLI's:
 * the danger is two engines writing this local folder, whatever remote each points at.
 */
export function pluginSyncActiveFromData(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const settings = raw as {
    userKey?: unknown;
    connectedVaultId?: unknown;
    syncPaused?: unknown;
  };
  return (
    typeof settings.userKey === "string" &&
    settings.userKey.trim() !== "" &&
    typeof settings.connectedVaultId === "string" &&
    settings.connectedVaultId.trim() !== "" &&
    settings.syncPaused !== true
  );
}

/** Whether Obsidian's enabled-plugins list contains the Courier plugin. */
export function pluginEnabledFromRegistry(raw: unknown): boolean {
  return Array.isArray(raw) && raw.includes("courier");
}

/** Read the plugin's state for one vault, or false when anything needed is absent. */
function pluginSyncActive(vaultPath: string): boolean {
  const pluginDir = path.join(vaultPath, ".obsidian", "plugins", "courier");
  if (!existsSync(path.join(pluginDir, "manifest.json"))) return false;
  if (
    !pluginEnabledFromRegistry(
      readJSON(path.join(vaultPath, ".obsidian", "community-plugins.json")),
    )
  ) {
    return false;
  }
  return pluginSyncActiveFromData(readJSON(path.join(pluginDir, "data.json")));
}

/**
 * Detect whether this daemon should park for Obsidian.
 *
 * A missing or unreadable registry means "Obsidian is not known to be open", which is
 * the ordinary case on a headless machine. A readable registry that marks this vault open
 * but a plugin that is disabled, unbound or paused means the CLI may run: the setting is
 * checked against the plugin's own state, not against the app's name.
 */
export function detectCoexistence(
  vault: Pick<CliVault, "vaultPath">,
  options: { obsidianConfigPath?: string } = {},
): Coexistence {
  const vaultPath = vault.vaultPath;
  if (!vaultPath) {
    return {
      obsidianOpen: false,
      pluginSyncActive: false,
      reason: "no-vault",
    };
  }
  const obsidianOpen = vaultOpenInRegistry(
    readJSON(options.obsidianConfigPath ?? obsidianConfigPath()),
    vaultPath,
  );
  if (!obsidianOpen) {
    return {
      obsidianOpen: false,
      pluginSyncActive: false,
      reason: "obsidian-closed",
    };
  }
  const active = pluginSyncActive(vaultPath);
  return {
    obsidianOpen: true,
    pluginSyncActive: active,
    reason: active ? "obsidian-plugin" : "obsidian-plugin-off",
  };
}

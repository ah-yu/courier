import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  detectCoexistence,
  pluginEnabledFromRegistry,
  pluginSyncActiveFromData,
  sameVaultPath,
  vaultOpenInRegistry,
} from "./coexistence";

/**
 * The coexistence rule is the answer to "what happens when Obsidian and the CLI both have
 * this vault open?". It is decided from data the two applications already write, so the
 * decision can be pinned without either of them running.
 */

function vaultFixture(data: unknown, enabled: string[] | null = ["courier"]): string {
  const vault = mkdtempSync(path.join(tmpdir(), "courier-vault-"));
  const plugin = path.join(vault, ".obsidian", "plugins", "courier");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(path.join(plugin, "manifest.json"), "{}");
  writeFileSync(path.join(plugin, "data.json"), JSON.stringify(data));
  if (enabled !== null) {
    writeFileSync(path.join(vault, ".obsidian", "community-plugins.json"), JSON.stringify(enabled));
  }
  return vault;
}

function registry(vault: string, open = true): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "courier-obsidian-")), "obsidian.json");
  writeFileSync(file, JSON.stringify({ vaults: { v1: { path: vault, ts: 1, open } } }));
  return file;
}

describe("vaultOpenInRegistry", () => {
  it("matches the vault path, not the vault's id or name", () => {
    const raw = { vaults: { id1: { path: "/mnt/vault", open: true } } };
    expect(vaultOpenInRegistry(raw, "/mnt/vault")).toBe(true);
    expect(vaultOpenInRegistry(raw, "/mnt/other")).toBe(false);
  });

  it("requires the open flag", () => {
    expect(vaultOpenInRegistry({ vaults: { id1: { path: "/mnt/vault" } } }, "/mnt/vault")).toBe(
      false,
    );
    expect(
      vaultOpenInRegistry({ vaults: { id1: { path: "/mnt/vault", open: false } } }, "/mnt/vault"),
    ).toBe(false);
  });

  it("ignores a malformed document instead of throwing", () => {
    expect(vaultOpenInRegistry(null, "/mnt/vault")).toBe(false);
    expect(vaultOpenInRegistry({ vaults: "no" }, "/mnt/vault")).toBe(false);
    expect(vaultOpenInRegistry({ vaults: { a: null, b: { path: 3 } } }, "/mnt/vault")).toBe(false);
  });

  it("compares paths the way the platform does", () => {
    expect(sameVaultPath("/mnt/vault/", "/mnt/vault")).toBe(true);
    expect(sameVaultPath("/mnt/vault", "/mnt/vault/sub")).toBe(false);
  });
});

describe("pluginSyncActiveFromData", () => {
  it("needs a key, a bound vault and no pause", () => {
    expect(pluginSyncActiveFromData({ userKey: "ck_a", connectedVaultId: "v1" })).toBe(true);
    expect(pluginSyncActiveFromData({ userKey: "ck_a" })).toBe(false);
    expect(pluginSyncActiveFromData({ connectedVaultId: "v1" })).toBe(false);
    expect(
      pluginSyncActiveFromData({ userKey: "ck_a", connectedVaultId: "v1", syncPaused: true }),
    ).toBe(false);
    expect(pluginSyncActiveFromData(null)).toBe(false);
  });
});

describe("pluginEnabledFromRegistry", () => {
  it("reads Obsidian's enabled plugin ids", () => {
    expect(pluginEnabledFromRegistry(["courier", "other"])).toBe(true);
    expect(pluginEnabledFromRegistry(["other"])).toBe(false);
    expect(pluginEnabledFromRegistry(null)).toBe(false);
  });
});

describe("detectCoexistence", () => {
  it("reports when Obsidian is open and the plugin would sync", () => {
    const vault = vaultFixture({ userKey: "ck_a", connectedVaultId: "v1" });
    const open = detectCoexistence({ vaultPath: vault }, { obsidianConfigPath: registry(vault) });

    expect(open).toEqual({
      obsidianOpen: true,
      pluginSyncActive: true,
      reason: "obsidian-plugin",
    });

    const closed = detectCoexistence(
      { vaultPath: vault },
      { obsidianConfigPath: registry(vault, false) },
    );
    expect(closed.reason).toBe("obsidian-closed");
  });

  it("reports an inactive plugin when it is disabled, unbound or paused", () => {
    const disabled = vaultFixture({ userKey: "ck_a", connectedVaultId: "v1" }, ["other"]);
    expect(
      detectCoexistence({ vaultPath: disabled }, { obsidianConfigPath: registry(disabled) }),
    ).toMatchObject({ pluginSyncActive: false, reason: "obsidian-plugin-off" });

    const unbound = vaultFixture({ userKey: "ck_a", connectedVaultId: null });
    expect(
      detectCoexistence({ vaultPath: unbound }, { obsidianConfigPath: registry(unbound) }),
    ).toMatchObject({ reason: "obsidian-plugin-off" });

    const paused = vaultFixture({
      userKey: "ck_a",
      connectedVaultId: "v1",
      syncPaused: true,
    });
    expect(
      detectCoexistence({ vaultPath: paused }, { obsidianConfigPath: registry(paused) }),
    ).toMatchObject({ reason: "obsidian-plugin-off" });
  });

  it("reports no vault or a closed registry without a plugin observation", () => {
    expect(detectCoexistence({ vaultPath: "" })).toMatchObject({
      reason: "no-vault",
    });
    expect(
      detectCoexistence(
        { vaultPath: "/mnt/vault" },
        { obsidianConfigPath: path.join(tmpdir(), "does-not-exist", "obsidian.json") },
      ),
    ).toMatchObject({ reason: "obsidian-closed" });
  });
});

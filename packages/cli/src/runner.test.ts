import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { SyncLease } from "@courier/engine";
import { afterEach, describe, expect, it } from "vitest";
import type { CliConfig, CliVault } from "./config";
import { setLocale } from "./i18n";
import { LeaseStore } from "./lease";
import { readRuntime } from "./runtime";
import { runDaemon, runOnceSync } from "./runner";

/**
 * One process owns one vault, first come first served. These tests hold the vault lease
 * as another writer would, then prove that neither the one-shot path nor the daemon builds
 * an engine behind it.
 */

const vaultPath = mkdtempSync(path.join(tmpdir(), "courier-cli-runner-"));

const vault: CliVault = {
  vaultId: "vault-1",
  vaultPath,
  encryptionKeyB64: "a2V5",
};

const config: CliConfig = {
  serverUrl: "http://vps.example.com",
  userKey: "ck_test",
  deviceName: "NAS",
  vaults: [vault],
};

function heldLease(): SyncLease {
  return new SyncLease({
    store: new LeaseStore(vaultPath),
    owner: "plugin",
    token: "plugin-token",
  });
}

describe("runOnceSync", () => {
  it("refuses to run behind a writer that already holds the lease", async () => {
    setLocale("en");
    const lease = heldLease();
    await lease.acquire();
    try {
      await expect(runOnceSync(config, vault)).rejects.toThrow("Another syncer");
    } finally {
      await lease.release();
    }
  });
});

describe("lease filesystem failures", () => {
  const previous = process.env.COURIER_CLI_CONFIG_DIR;
  afterEach(() => {
    if (previous === undefined) delete process.env.COURIER_CLI_CONFIG_DIR;
    else process.env.COURIER_CLI_CONFIG_DIR = previous;
  });

  /** A vault whose `.courier` path is a file, so creating the lease fails with EEXIST. */
  function brokenVault(): { vault: CliVault; config: CliConfig; dir: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "courier-cli-lease-error-"));
    const vaultDir = path.join(dir, "vault");
    mkdirSync(vaultDir);
    writeFileSync(path.join(vaultDir, ".courier"), "not a directory");
    const broken: CliVault = {
      vaultId: "vault-broken",
      vaultPath: vaultDir,
      encryptionKeyB64: "a2V5",
    };
    return { vault: broken, config: { ...config, vaults: [broken] }, dir };
  }

  it("reports the error instead of waiting for another writer", async () => {
    setLocale("en");
    const { vault: broken, config: brokenConfig, dir } = brokenVault();
    process.env.COURIER_CLI_CONFIG_DIR = path.join(dir, "cli-config");
    try {
      await expect(
        runDaemon(brokenConfig, broken, { leaseRetryMs: 10, onLog: () => {} }),
      ).rejects.toThrow(/Cannot access the sync lease/);
      expect(readRuntime(broken.vaultId)).toMatchObject({
        phase: "stopped",
        reason: "failed",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the same error from a one-shot pass", async () => {
    setLocale("en");
    const { vault: broken, config: brokenConfig, dir } = brokenVault();
    try {
      await expect(runOnceSync(brokenConfig, broken)).rejects.toThrow(
        /Cannot access the sync lease/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runDaemon", () => {
  const previous = process.env.COURIER_CLI_CONFIG_DIR;
  afterEach(() => {
    if (previous === undefined) delete process.env.COURIER_CLI_CONFIG_DIR;
    else process.env.COURIER_CLI_CONFIG_DIR = previous;
  });

  it("waits for the lease before the first pass and writes only this vault's record", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "courier-cli-run-"));
    process.env.COURIER_CLI_CONFIG_DIR = dir;

    const lease = heldLease();
    await lease.acquire();
    const handle = await runDaemon(config, vault, {
      leaseRetryMs: 10,
      onLog: () => {},
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(handle.engine).toBeNull();
      const runtime = readRuntime(vault.vaultId);
      expect(runtime).toMatchObject({
        vaultId: "vault-1",
        phase: "waiting",
        reason: "other-writer",
      });
      expect(runtime?.vaultPath).toBe(vaultPath);
      expect(readRuntime("vault-2")).toBeNull();
    } finally {
      await handle.stop();
      await lease.release();
    }
    expect(readRuntime(vault.vaultId)).toBeNull();
  });
});

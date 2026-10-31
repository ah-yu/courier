import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RuntimeWriter,
  clearRuntime,
  daemonStatus,
  processAlive,
  readRuntime,
  runtimePath,
} from "./runtime";

/**
 * Each vault's daemon has its own `runtime/<vault>.json`. The one rule that must hold is
 * that it is **advisory**: a dead pid reads as stopped even when the file is still there,
 * because a crashed daemon never gets to clean up. And two vaults must never share a
 * record.
 */

let dir: string;
let previous: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "courier-runtime-"));
  previous = process.env.COURIER_CLI_CONFIG_DIR;
  process.env.COURIER_CLI_CONFIG_DIR = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.COURIER_CLI_CONFIG_DIR;
  else process.env.COURIER_CLI_CONFIG_DIR = previous;
});

const vault = { vaultId: "vault-1", vaultPath: "/mnt/vault" };

describe("runtime", () => {
  it("records this process and reports it alive for its own vault", () => {
    const writer = new RuntimeWriter(vault, "https://vps.example.com", "NAS");
    writer.start();
    writer.set({ phase: "syncing", reason: "running" });
    writer.touchActivity();

    const status = daemonStatus(vault.vaultId);
    expect(status).toMatchObject({
      running: true,
      pid: process.pid,
      phase: "syncing",
      reason: "running",
      lastActivityAt: expect.any(String),
    });
    expect(readRuntime(vault.vaultId)).toMatchObject({
      vaultId: "vault-1",
      vaultPath: "/mnt/vault",
      deviceName: "NAS",
    });
    // A different vault has no record; one process never claims another vault.
    expect(daemonStatus("vault-2").running).toBe(false);
    expect(runtimePath("vault-1")).not.toBe(runtimePath("vault-2"));
  });

  it("treats a dead pid as stopped and drops the stale record", () => {
    mkdirSync(path.dirname(runtimePath(vault.vaultId)), { recursive: true });
    writeFileSync(
      runtimePath(vault.vaultId),
      JSON.stringify({
        version: 1,
        vaultId: vault.vaultId,
        vaultPath: vault.vaultPath,
        pid: 2147483646,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        phase: "syncing",
        reason: "running",
        serverUrl: "https://vps.example.com",
        deviceName: "NAS",
      }),
    );

    const status = daemonStatus(vault.vaultId);
    expect(status.running).toBe(false);
    expect(status.pid).toBe(2147483646);
    expect(status.phase).toBeNull();
    expect(readRuntime(vault.vaultId)).toBeNull();
  });

  it("ignores an unreadable record and clears on stop", () => {
    mkdirSync(path.dirname(runtimePath(vault.vaultId)), { recursive: true });
    writeFileSync(runtimePath(vault.vaultId), "{not json");
    expect(readRuntime(vault.vaultId)).toBeNull();
    expect(daemonStatus(vault.vaultId).running).toBe(false);

    const writer = new RuntimeWriter(vault, "https://vps.example.com", "NAS");
    writer.start();
    expect(processAlive(process.pid)).toBe(true);
    writer.clear();
    expect(readRuntime(vault.vaultId)).toBeNull();
    writeFileSync(runtimePath(vault.vaultId), "{}");
    clearRuntime(vault.vaultId);
    expect(readRuntime(vault.vaultId)).toBeNull();
  });

  it("records a pass's counter, and forgets it when the phase changes", () => {
    const writer = new RuntimeWriter(vault, "https://vps.example.com", "NAS");
    writer.start();

    writer.setProgress(1200, 10000);
    expect(daemonStatus(vault.vaultId).progress).toEqual({ done: 1200, total: 10000 });

    // The next report inside the throttle window is dropped: a 25-file step would
    // otherwise rewrite this file for every step of a bind.
    writer.setProgress(1225, 10000);
    expect(daemonStatus(vault.vaultId).progress).toEqual({ done: 1200, total: 10000 });

    // A phase change means the pass is over; a finished counter is not progress.
    writer.set({ phase: "syncing", reason: "running" });
    expect(daemonStatus(vault.vaultId).progress).toBeNull();
  });

  it("marks a record whose device had never synced the vault", () => {
    const fresh = new RuntimeWriter(
      vault,
      "https://vps.example.com",
      "NAS",
      () => new Date(),
      true,
    );
    fresh.start();
    expect(daemonStatus(vault.vaultId).firstSync).toBe(true);

    const known = new RuntimeWriter(vault, "https://vps.example.com", "NAS");
    known.start();
    expect(daemonStatus(vault.vaultId).firstSync).toBe(false);
  });

  it("drops a malformed counter instead of reporting it", () => {
    mkdirSync(path.dirname(runtimePath(vault.vaultId)), { recursive: true });
    writeFileSync(
      runtimePath(vault.vaultId),
      JSON.stringify({
        version: 1,
        vaultId: vault.vaultId,
        vaultPath: vault.vaultPath,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        phase: "starting",
        reason: "startup",
        progress: { done: -1, total: 0 },
      }),
    );

    const record = readRuntime(vault.vaultId);
    expect(record?.progress).toBeUndefined();
    expect(daemonStatus(vault.vaultId).progress).toBeNull();
  });
});

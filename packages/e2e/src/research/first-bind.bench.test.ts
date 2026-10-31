/**
 * Research benchmark: what a **first bind** of a large local vault costs.
 *
 * Not a test of a rule — it asserts nothing about correctness. It drives the real
 * `SyncEngine`, the real CLI adapter and a real server (SQLite + Hono + ws) over a
 * synthetic vault of N files and reports where the wall-clock time goes. Run it
 * only on purpose:
 *
 * ```bash
 * COURIER_BENCH=1 bun --bun vitest run packages/e2e/src/research/first-bind.bench.test.ts
 * ```
 *
 * `COURIER_BENCH_FILES` overrides the local file count (default 2000).
 * `COURIER_BENCH_WAL=1` puts the database in WAL mode (what `courier migrate` does
 * in production; the harness's own schema setup leaves SQLite's default journal).
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, it } from "vitest";
import { startTestServer, type TestServer } from "../harness/server";
import { createTestVault, makeVaultMaterial, type VaultMaterial } from "../harness/vault";
import { makeVault, report, runEngine } from "./timing";

const enabled = process.env.COURIER_BENCH === "1";
const LOCAL_FILES = Number(process.env.COURIER_BENCH_FILES ?? "2000");
const USE_WAL = process.env.COURIER_BENCH_WAL === "1";
const journal = USE_WAL ? "wal" : "delete";

describe.skipIf(!enabled)("research — first bind cost", () => {
  let server: TestServer;
  let material: VaultMaterial;
  const dirs: string[] = [];

  beforeAll(async () => {
    server = await startTestServer("bench user");
    if (USE_WAL) {
      const handle = new Database(join(server.rootDir, "courier.db"));
      handle.exec("PRAGMA journal_mode = WAL");
      handle.close();
    }
    material = await makeVaultMaterial();
  }, 300_000);

  afterAll(async () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    await server.close();
  }, 120_000);

  it("binds a fresh vault of N local files into an empty remote", async () => {
    const vault = await createTestVault(server, "upload-bind", material);
    const dir = mkdtempSync(join(tmpdir(), "courier-bench-upload-"));
    dirs.push(dir);
    const bytes = makeVault(dir, LOCAL_FILES);

    const bound = await runEngine("upload bind (empty remote)", {
      dir,
      server,
      vaultId: vault.id,
      key: material.key,
      files: LOCAL_FILES + 1,
      bytes,
      firstBind: true,
    });
    report(bound, journal);

    // Second pass over the same state: the steady state (list + one stat per file
    // + one index request) that every five-minute reconcile pays.
    const again = await runEngine("second pass (all tracked)", {
      dir,
      server,
      vaultId: vault.id,
      key: material.key,
      files: LOCAL_FILES + 1,
      bytes,
      firstBind: false,
      previous: bound,
    });
    report(again, journal);
  }, 900_000);

  it("binds an empty local vault against a remote holding M files", async () => {
    const vault = await createTestVault(server, "pull-bind", material);
    const peerDir = mkdtempSync(join(tmpdir(), "courier-bench-peer-"));
    dirs.push(peerDir);
    const bytes = makeVault(peerDir, LOCAL_FILES);
    const seed = await runEngine("peer seeds the remote", {
      dir: peerDir,
      server,
      vaultId: vault.id,
      key: material.key,
      files: LOCAL_FILES + 1,
      bytes,
      firstBind: true,
    });
    report(seed, journal);

    const emptyDir = mkdtempSync(join(tmpdir(), "courier-bench-empty-"));
    dirs.push(emptyDir);
    const pulled = await runEngine("download bind (remote full)", {
      dir: emptyDir,
      server,
      vaultId: vault.id,
      key: material.key,
      files: LOCAL_FILES + 1,
      bytes,
      firstBind: true,
    });
    report(pulled, journal);

    // A second pass over the same client: what the next five-minute reconcile does.
    const catchUp = await runEngine("download bind (second pass)", {
      dir: emptyDir,
      server,
      vaultId: vault.id,
      key: material.key,
      files: LOCAL_FILES + 1,
      bytes,
      firstBind: false,
      previous: pulled,
    });
    report(catchUp, journal);
  }, 900_000);
});

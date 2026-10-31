import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { removeDirWithRetry } from "@courier/testing";
import { runMigrations } from "../db/migrations";

/**
 * The retention pass — the one code path in the server that **destroys** version
 * rows and blobs.
 *
 * `lib/prune.test.ts` pins the selection rule ("the latest version always stays"),
 * and `lib/quota.test.ts` pins the cutoff. What neither can see is the loop that
 * applies them: the `(created_at, rowid)` ordering it relies on, the per-row delete,
 * the blob reclaim, and the "no window means no pass" branch. A mistake there
 * deletes the wrong row or leaves the bytes behind, and nothing else in the suite
 * runs this function against a real database.
 *
 * `../db/index` opens `SQLITE_PATH` at import time and `blob-store` reads
 * `BLOB_STORE_DIR` the same way, so both are set before the dynamic import; the
 * schema comes from the server's own `runMigrations`, exactly as `courier migrate`
 * and the e2e harness build it.
 */

/** `now - days` as the ISO string SQLite stores. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("retention pruning — the pass that deletes rows and blobs", () => {
  let dir: string;
  let blobDir: string;
  let previousSqlitePath: string | undefined;
  let previousBlobDir: string | undefined;
  let sqlite: Database;
  let closeDb: () => void;
  let runPruneOnce: (now?: Date) => Promise<{ prunedRows: number; prunedBlobs: number }>;
  let startPruneLoop: (intervalMs: number) => () => void;
  let store: typeof import("../lib/blob-store");

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "courier-prune-"));
    blobDir = path.join(dir, "blobs");
    previousSqlitePath = process.env["SQLITE_PATH"];
    previousBlobDir = process.env["BLOB_STORE_DIR"];
    process.env["SQLITE_PATH"] = path.join(dir, "test.db");
    process.env["BLOB_STORE_DIR"] = blobDir;

    const database = await import("../db/index");
    sqlite = database.sqlite;
    closeDb = database.closeDb;
    runMigrations(sqlite);
    ({ runPruneOnce, startPruneLoop } = await import("./prune"));
    store = await import("../lib/blob-store");
  });

  afterAll(async () => {
    closeDb();
    // Windows keeps the file mapped for a moment after `close()`; retry the
    // removal instead of failing the suite on a transient lock.
    await removeDirWithRetry(dir);
    if (previousSqlitePath === undefined) delete process.env["SQLITE_PATH"];
    else process.env["SQLITE_PATH"] = previousSqlitePath;
    if (previousBlobDir === undefined) delete process.env["BLOB_STORE_DIR"];
    else process.env["BLOB_STORE_DIR"] = previousBlobDir;
  });

  /** One account, with the vault count and window the case needs. */
  function insertUser(id: string, retentionDays: number | null): void {
    sqlite
      .prepare("INSERT INTO users (id, name, key, retention_days) VALUES (?, ?, ?, ?)")
      .run(id, id, `ck_${id}`, retentionDays);
  }

  function insertVault(id: string, ownerUserId: string | null): void {
    sqlite
      .prepare("INSERT INTO vaults (id, name, owner_user_id) VALUES (?, ?, ?)")
      .run(id, id, ownerUserId);
  }

  /** One version row; `rowid` follows insertion order, which chain order also uses. */
  function insertVersion(
    vaultId: string,
    fileId: string,
    versionId: string,
    createdAt: string,
    contentHash: string,
  ): void {
    sqlite
      .prepare(
        `INSERT INTO file_versions
           (id, vault_id, file_id, encrypted_path, version_id, content_hash, size_bytes, mtime_ms, action, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `row-${versionId}`,
        vaultId,
        fileId,
        `enc-${fileId}`,
        versionId,
        contentHash,
        1,
        0,
        "create",
        createdAt,
      );
  }

  function versionsOf(vaultId: string, fileId: string): string[] {
    return (
      sqlite
        .prepare(
          "SELECT version_id FROM file_versions WHERE vault_id = ? AND file_id = ? ORDER BY created_at, rowid",
        )
        .all(vaultId, fileId) as Array<{ version_id: string }>
    ).map((row) => row.version_id);
  }

  /** Publish a blob the way a push does: append, flush, index. */
  async function writeBlob(vaultId: string, contentHash: string): Promise<void> {
    await store.writeBlob(vaultId, contentHash, new Uint8Array([1, 2, 3]));
    await store.flushBlobWrites(vaultId);
  }

  /**
   * The row/blob counts a case compares against itself.
   *
   * The file shares one database and one blob store between cases, and `runPruneOnce`
   * covers every account: a hard-coded total is only right while nothing an earlier case
   * created is still prunable, and a case inserted between them would silently change it.
   * Taking counts before and after makes each expectation describe its own vaults.
   */
  function rowsIn(vaultId: string): number {
    const row = sqlite
      .prepare("SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?")
      .get(vaultId) as { n: number };
    return row.n;
  }

  /** How many blobs the index says the vault holds (the bytes may outlive a row). */
  function blobsIn(vaultId: string): number {
    const row = sqlite
      .prepare("SELECT COUNT(*) AS n FROM blobs WHERE vault_id = ?")
      .get(vaultId) as { n: number };
    return row.n;
  }

  it("prunes the aged tail of every chain and keeps each chain's latest version", async () => {
    insertUser("u-tail", 30);
    insertVault("v-tail", "u-tail");
    // f-3: two of three rows are older than the window; the latest is not.
    insertVersion("v-tail", "f-3", "f3-old", daysAgo(60), "h-3-old");
    insertVersion("v-tail", "f-3", "f3-mid", daysAgo(40), "h-3-mid");
    insertVersion("v-tail", "f-3", "f3-new", daysAgo(1), "h-3-new");
    // f-2: both rows are older than the window. The latest must still survive — it is
    // the live state of the file, and deleting it would lose the path and its content.
    insertVersion("v-tail", "f-2", "f2-old", daysAgo(90), "h-2-old");
    insertVersion("v-tail", "f-2", "f2-latest", daysAgo(45), "h-2-latest");

    const beforeRows = rowsIn("v-tail");
    const result = await runPruneOnce();

    expect(beforeRows - rowsIn("v-tail")).toBe(3);
    expect(result.prunedRows).toBe(beforeRows - rowsIn("v-tail"));
    expect(versionsOf("v-tail", "f-3")).toEqual(["f3-new"]);
    expect(versionsOf("v-tail", "f-2")).toEqual(["f2-latest"]);
  });

  it("reclaims the blobs those rows referenced, and only those", async () => {
    insertUser("u-blob", 30);
    insertVault("v-blob", "u-blob");
    insertVersion("v-blob", "f-keep", "fk-old", daysAgo(60), "h-keep-gone");
    insertVersion("v-blob", "f-keep", "fk-new", daysAgo(1), "h-keep");
    await writeBlob("v-blob", "h-keep");
    await writeBlob("v-blob", "h-keep-gone");
    // No row in `file_versions`: an orphan the pass is responsible for reclaiming.
    await writeBlob("v-blob", "h-orphan");

    const beforeRows = rowsIn("v-blob");
    const beforeBlobs = blobsIn("v-blob");
    const result = await runPruneOnce();

    expect(beforeRows - rowsIn("v-blob")).toBe(1);
    expect(beforeBlobs - blobsIn("v-blob")).toBe(2);
    expect(result.prunedRows).toBe(beforeRows - rowsIn("v-blob"));
    expect(result.prunedBlobs).toBe(beforeBlobs - blobsIn("v-blob"));
    expect(await store.hasBlob("v-blob", "h-keep")).toBe(true);
    expect(await store.hasBlob("v-blob", "h-keep-gone")).toBe(false);
    expect(await store.hasBlob("v-blob", "h-orphan")).toBe(false);
  });

  it("leaves a vault alone when its owner has no retention window", async () => {
    insertUser("u-forever", null);
    insertVault("v-forever", "u-forever");
    insertVersion("v-forever", "f-1", "f1-old", daysAgo(3_650), "h-forever");
    insertVersion("v-forever", "f-1", "f1-new", daysAgo(1), "h-forever-new");
    await writeBlob("v-forever", "h-forever");
    await writeBlob("v-forever", "h-unreferenced");

    const beforeRows = rowsIn("v-forever");
    const beforeBlobs = blobsIn("v-forever");
    const result = await runPruneOnce();

    // No window means no rows and no blobs: an account that keeps history forever keeps
    // its old versions *and* the bytes they name, even the unreferenced ones.
    expect(result.prunedRows).toBe(0);
    expect(result.prunedBlobs).toBe(0);
    expect(rowsIn("v-forever")).toBe(beforeRows);
    expect(blobsIn("v-forever")).toBe(beforeBlobs);
    expect(versionsOf("v-forever", "f-1")).toEqual(["f1-old", "f1-new"]);
    expect(await store.hasBlob("v-forever", "h-unreferenced")).toBe(true);
  });

  it("does not schedule a pass at all when the interval is not positive", () => {
    // `PRUNE_INTERVAL_MS=0` is the documented way to turn pruning off. Handing 0 to
    // `setInterval` would run the pass in a tight loop — the opposite of that setting.
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      const stop = startPruneLoop(0);
      expect(setIntervalSpy).not.toHaveBeenCalled();
      // The returned stopper is still callable, so a caller never has to branch.
      expect(() => stop()).not.toThrow();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("schedules a pass and stops it when the stopper is called", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    try {
      const stop = startPruneLoop(5_000);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(5_000);
      stop();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });
});

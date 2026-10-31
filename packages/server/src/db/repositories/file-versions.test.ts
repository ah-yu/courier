import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { removeDirWithRetry } from "@courier/testing";
import { sortedCopy } from "@courier/shared";
import { runMigrations } from "../migrations";

function chainOf(
  chains: Awaited<ReturnType<typeof import("./file-versions").listFileHeadsByVaultId>>,
  fileId: string,
): (typeof chains)[number] {
  const chain = chains.find((entry) => entry.fileId === fileId);
  if (!chain) throw new Error(`no chain for ${fileId}`);
  return chain;
}

/**
 * The recycle bin's order, at the one place it is decided: the SQL.
 *
 * The dialog sorts by `deletedAt` with a stable sort, so a tie — two deletions inside the
 * same millisecond — is whatever order the server returned them in. That order used to be
 * whatever SQLite happened to produce, which is how "lists the newest deletion first"
 * failed once under load and passed when re-run. The query now orders by
 * `(created_at DESC, rowid DESC)`, and only a same-millisecond pair can tell that apart
 * from the old query, which is exactly what this test inserts.
 *
 * `src/db/index.ts` opens `SQLITE_PATH` when it is imported, so the env is set before the
 * dynamic import, and the schema is created by the server's own `runMigrations` — the
 * same code `courier migrate` and the e2e harness run.
 */
describe("listDeletedChains — the recycle bin's order", () => {
  let dir: string;
  let previousSqlitePath: string | undefined;
  let sqlite: Database;
  let db: (typeof import("../index"))["db"];
  let closeDb: () => void;
  let listDeletedChains: typeof import("./file-versions").listDeletedChains;
  let listFileHeadsByVaultId: typeof import("./file-versions").listFileHeadsByVaultId;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "courier-deleted-order-"));
    previousSqlitePath = process.env["SQLITE_PATH"];
    process.env["SQLITE_PATH"] = join(dir, "test.db");
    const database = await import("../index");
    sqlite = database.sqlite;
    db = database.db;
    closeDb = database.closeDb;
    runMigrations(sqlite);
    sqlite.prepare("INSERT INTO vaults (id, name) VALUES (?, ?)").run("vault-1", "test vault");
    ({ listDeletedChains } = await import("./file-versions"));
    ({ listFileHeadsByVaultId } = await import("./file-versions"));
  });

  afterAll(async () => {
    closeDb();
    await removeDirWithRetry(dir);
    if (previousSqlitePath === undefined) delete process.env["SQLITE_PATH"];
    else process.env["SQLITE_PATH"] = previousSqlitePath;
  });

  /** One row of a chain, in the order it was inserted. */
  function insertVersion(
    id: string,
    fileId: string,
    action: "create" | "modify" | "rename" | "delete" | "restore",
    createdAt: string,
    contentHash = "content-hash",
    vaultId = "vault-1",
  ): void {
    sqlite
      .prepare(
        `INSERT INTO file_versions
           (id, vault_id, file_id, encrypted_path, version_id, content_hash, size_bytes,
            mtime_ms, action, device_name, created_at)
         VALUES (?, ?, ?, 'encrypted-path', ?, ?, 0, 0, ?, 'test-device', ?)`,
      )
      .run(id, vaultId, fileId, `${id}-version`, contentHash, action, createdAt);
  }

  it("returns two deletions from the same millisecond newest-insert first", async () => {
    const shared = "2026-10-19T02:00:00.000Z";
    const older = "2026-10-19T01:00:00.000Z";
    insertVersion("first-create", "first", "create", older);
    insertVersion("first-delete", "first", "delete", shared);
    insertVersion("second-create", "second", "create", older);
    insertVersion("second-delete", "second", "delete", shared);

    const chains = await listDeletedChains("vault-1");
    // The tie is broken by insertion order, so the delete that landed second is first.
    expect(chains.map((chain) => chain.fileId)).toEqual(["second", "first"]);
    expect(chains.map((chain) => chain.last.versionId)).toEqual([
      "second-delete-version",
      "first-delete-version",
    ]);
    expect(chains.every((chain) => chain.previous !== null)).toBe(true);
  });

  it("still answers newest deletion first when the timestamps differ", async () => {
    insertVersion("third-create", "third", "create", "2026-10-19T03:00:00.000Z");
    insertVersion("third-delete", "third", "delete", "2026-10-19T04:00:00.000Z");

    const chains = await listDeletedChains("vault-1");
    expect(chains[0]?.fileId).toBe("third");
  });

  it("restores the newest live version when a chain carries consecutive deletes", async () => {
    // A delete can be pushed with another delete as its base (the server accepts it),
    // so the row immediately before the head is not a restorable version. The second
    // row of this chain is a delete; the create is the version the first delete removed.
    insertVersion(
      "deleted-twice-create",
      "twice-deleted",
      "create",
      "2026-10-19T05:00:00.000Z",
      "h-live",
    );
    insertVersion(
      "deleted-twice-delete-1",
      "twice-deleted",
      "delete",
      "2026-10-19T06:00:00.000Z",
      "h-del-1",
    );
    insertVersion(
      "deleted-twice-delete-2",
      "twice-deleted",
      "delete",
      "2026-10-19T07:00:00.000Z",
      "h-del-2",
    );

    const chain = (await listDeletedChains("vault-1")).find(
      (entry) => entry.fileId === "twice-deleted",
    )!;

    expect(chain.last.versionId).toBe("deleted-twice-delete-2-version");
    expect(chain.previous?.versionId).toBe("deleted-twice-create-version");
    expect(chain.previous?.contentHash).toBe("h-live");
  });

  it("offers no restorable version for a chain that holds only deletes", async () => {
    insertVersion("deleted-only-delete", "only-delete-chain", "delete", "2026-10-19T08:00:00.000Z");

    const chain = (await listDeletedChains("vault-1")).find(
      (entry) => entry.fileId === "only-delete-chain",
    )!;

    expect(chain.last.versionId).toBe("deleted-only-delete-version");
    expect(chain.previous).toBeNull();
  });

  /**
   * The engine's cold-start read: one row per chain (its head), plus the last live
   * version only when the head is a tombstone. The head has to be the same row the
   * conditional insert treats as the head, or a client's `baseVersionId` is refused.
   */
  describe("listFileHeadsByVaultId", () => {
    it("returns the live head and no previous version for a live chain", async () => {
      insertVersion("live-create", "heads-live", "create", "2026-10-20T00:00:00.000Z", "h-1");
      insertVersion("live-modify", "heads-live", "modify", "2026-10-20T01:00:00.000Z", "h-2");

      const chain = chainOf(await listFileHeadsByVaultId("vault-1"), "heads-live");

      expect(chain.head.versionId).toBe("live-modify-version");
      expect(chain.head.contentHash).toBe("h-2");
      expect(chain.previousLive).toBeNull();
    });

    it("returns the last live version under a tombstone", async () => {
      insertVersion("dead-create", "heads-dead", "create", "2026-10-20T00:00:00.000Z", "h-1");
      insertVersion("dead-modify", "heads-dead", "modify", "2026-10-20T01:00:00.000Z", "h-2");
      insertVersion("dead-delete", "heads-dead", "delete", "2026-10-20T02:00:00.000Z", "h-del");

      const chain = chainOf(await listFileHeadsByVaultId("vault-1"), "heads-dead");

      expect(chain.head.versionId).toBe("dead-delete-version");
      expect(chain.head.action).toBe("delete");
      expect(chain.previousLive?.versionId).toBe("dead-modify-version");
      expect(chain.previousLive?.contentHash).toBe("h-2");
    });

    it("walks past deletes to the latest live version (delete → restore → delete)", async () => {
      insertVersion("res-create", "heads-restore", "create", "2026-10-20T00:00:00.000Z", "h-1");
      insertVersion("res-delete", "heads-restore", "delete", "2026-10-20T01:00:00.000Z", "h-del-1");
      insertVersion("res-restore", "heads-restore", "restore", "2026-10-20T02:00:00.000Z", "h-2");
      insertVersion(
        "res-delete-2",
        "heads-restore",
        "delete",
        "2026-10-20T03:00:00.000Z",
        "h-del-2",
      );

      const chain = chainOf(await listFileHeadsByVaultId("vault-1"), "heads-restore");

      expect(chain.head.versionId).toBe("res-delete-2-version");
      expect(chain.previousLive?.versionId).toBe("res-restore-version");
      expect(chain.previousLive?.contentHash).toBe("h-2");
    });

    it("answers no previous version for a chain that holds only a delete", async () => {
      insertVersion("only-delete", "heads-only-delete", "delete", "2026-10-20T00:00:00.000Z");

      const chain = chainOf(await listFileHeadsByVaultId("vault-1"), "heads-only-delete");

      expect(chain.head.versionId).toBe("only-delete-version");
      expect(chain.previousLive).toBeNull();
    });

    it("answers only the live head for a chain that was deleted and restored", async () => {
      // The older delete must not be picked as a previous live version: this head is
      // live, and the engine reads `previousLive` only under a tombstone.
      insertVersion("revive-create", "heads-revived", "create", "2026-10-20T00:00:00.000Z");
      insertVersion("revive-delete", "heads-revived", "delete", "2026-10-20T01:00:00.000Z");
      insertVersion("revive-restore", "heads-revived", "restore", "2026-10-20T02:00:00.000Z");

      const chain = chainOf(await listFileHeadsByVaultId("vault-1"), "heads-revived");

      expect(chain.head.versionId).toBe("revive-restore-version");
      expect(chain.head.action).toBe("restore");
      expect(chain.previousLive).toBeNull();
    });

    it("walks past two consecutive deletes to the version they removed", async () => {
      // The second delete is newer than the first, so `previousLive` is at rn=3 (not the
      // head's immediate predecessor). This is the shape that pins the mapping to the
      // query's `ORDER BY file_id, rn`.
      insertVersion("twice-create", "heads-twice-deleted", "create", "2026-10-20T00:00:00.000Z");
      insertVersion("twice-delete-1", "heads-twice-deleted", "delete", "2026-10-20T01:00:00.000Z");
      insertVersion("twice-delete-2", "heads-twice-deleted", "delete", "2026-10-20T02:00:00.000Z");

      const chain = chainOf(await listFileHeadsByVaultId("vault-1"), "heads-twice-deleted");

      expect(chain.head.versionId).toBe("twice-delete-2-version");
      expect(chain.previousLive?.versionId).toBe("twice-create-version");
    });

    it("does not return another vault's chains", async () => {
      sqlite.prepare("INSERT OR IGNORE INTO vaults (id, name) VALUES ('vault-2', 'other')").run();
      insertVersion(
        "other-vault-create",
        "heads-other-vault",
        "create",
        "2026-10-20T00:00:00.000Z",
        "h-other",
        "vault-2",
      );

      const chains = await listFileHeadsByVaultId("vault-1");

      expect(chains.some((entry) => entry.fileId === "heads-other-vault")).toBe(false);
    });

    it("breaks a same-millisecond tie by rowid, like every other reader of the head", async () => {
      const shared = "2026-10-20T04:00:00.000Z";
      insertVersion("tie-create", "heads-tie", "create", "2026-10-20T03:00:00.000Z", "h-1");
      insertVersion("tie-modify", "heads-tie", "modify", shared, "h-2");
      insertVersion("tie-delete", "heads-tie", "delete", shared, "h-del");

      const chain = chainOf(await listFileHeadsByVaultId("vault-1"), "heads-tie");

      expect(chain.head.versionId).toBe("tie-delete-version");
      // The later-inserted non-delete row wins the previous-live slot, not the create.
      expect(chain.previousLive?.versionId).toBe("tie-modify-version");
    });
  });

  /**
   * The conditional insert, in the shape a push batch uses it: every row of one request
   * in **one** transaction, still checked against its own chain's head.
   *
   * A per-file commit was ~0.9 ms of the server's ~1.3 ms marginal cost per file, which
   * is most of a first bind's server time (see `docs/first-bind-performance.md`).
   */
  describe("tryInsertFileVersions — one transaction per batch", () => {
    let tryInsertFileVersions: typeof import("./file-versions").tryInsertFileVersions;
    const vaultId = "vault-batch";

    beforeAll(async () => {
      sqlite.prepare("INSERT OR IGNORE INTO vaults (id, name) VALUES (?, ?)").run(vaultId, "batch");
      ({ tryInsertFileVersions } = await import("./file-versions"));
    });

    /** A version row as the push handler builds it. */
    function row(
      fileId: string,
      versionId: string,
      baseVersionId: string | null = null,
    ): Parameters<typeof tryInsertFileVersions>[0][number] {
      return {
        id: `id-${fileId}-${versionId}`,
        vaultId,
        fileId,
        encryptedPath: `enc-${fileId}`,
        versionId,
        contentHash: `hash-${versionId}`,
        sizeBytes: 0,
        mtimeMs: 1_760_000_000_000,
        action: "create",
        deviceName: "test-device",
        baseVersionId,
      };
    }

    it("appends every row of a batch and answers per row", async () => {
      const results = await tryInsertFileVersions([
        row("batch-a", "a-1"),
        row("batch-b", "b-1"),
        row("batch-c", "c-1"),
      ]);

      expect(results).toEqual([{ status: "ok" }, { status: "ok" }, { status: "ok" }]);
      const heads = await listFileHeadsByVaultId(vaultId);
      expect(sortedCopy(heads.map((entry) => entry.fileId))).toEqual([
        "batch-a",
        "batch-b",
        "batch-c",
      ]);
    });

    it("refuses the stale row without discarding the rest of the batch", async () => {
      // `batch-a` is at a-1; a push decided from "some-other-head" is refused.
      const results = await tryInsertFileVersions([
        row("batch-d", "d-1"),
        row("batch-a", "a-2", "some-other-head"),
        row("batch-e", "e-1"),
      ]);

      expect(results).toEqual([
        { status: "ok" },
        { status: "stale_base", currentVersionId: "a-1" },
        { status: "ok" },
      ]);
      const heads = await listFileHeadsByVaultId(vaultId);
      expect(heads.some((entry) => entry.fileId === "batch-d")).toBe(true);
      expect(heads.some((entry) => entry.fileId === "batch-e")).toBe(true);
      // The refused version was not written.
      expect(heads.find((entry) => entry.fileId === "batch-a")?.head.versionId).toBe("a-1");
    });

    it("checks a second row for the same chain against the first one it inserted", async () => {
      // Two versions of one chain in one batch: the second must see the first as the
      // head, exactly as two separate requests would.
      const results = await tryInsertFileVersions([
        row("batch-f", "f-1"),
        row("batch-f", "f-2", "not-the-head"),
      ]);

      expect(results).toEqual([
        { status: "ok" },
        { status: "stale_base", currentVersionId: "f-1" },
      ]);
      const head = (await listFileHeadsByVaultId(vaultId)).find(
        (entry) => entry.fileId === "batch-f",
      )?.head;
      expect(head?.versionId).toBe("f-1");
    });

    it("accepts a base that matches the current head", async () => {
      const results = await tryInsertFileVersions([row("batch-a", "a-3", "a-1")]);

      expect(results).toEqual([{ status: "ok" }]);
      const head = (await listFileHeadsByVaultId(vaultId)).find(
        (entry) => entry.fileId === "batch-a",
      )?.head;
      expect(head?.versionId).toBe("a-3");
    });

    it("answers nothing for an empty batch, without opening a transaction", async () => {
      // The early return is the contract, not an optimisation detail: an empty push batch
      // must not begin (and commit) an empty transaction. Asserting only `[]` would pass
      // for a transaction that wrote nothing, so the transaction itself is watched.
      const transaction = vi.spyOn(db, "transaction");
      try {
        await expect(tryInsertFileVersions([])).resolves.toEqual([]);
        expect(transaction).not.toHaveBeenCalled();
      } finally {
        transaction.mockRestore();
      }
    });
  });
});

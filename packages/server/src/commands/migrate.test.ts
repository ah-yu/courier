import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../config";
import { removeDirWithRetry } from "@courier/testing";
import { runMigrate } from "./migrate";
import { MIGRATIONS } from "../db/migrations.generated";

/**
 * Run the real command against the database `beforeEach` pointed it at.
 *
 * `config` is a plain object computed from the environment at import, so the
 * test retargets it in place. Vitest imports every test file once, and the command
 * itself reads `config.SQLITE_PATH` when it runs, so nothing has to be re-imported.
 */
async function migrate(options: { dryRun?: boolean } = {}): Promise<void> {
  await runMigrate(options);
}

/**
 * The refusal rules have to hold in the command, not only in `runMigrations`:
 * `courier migrate` is the process that runs on a server, and it has an early
 * "nothing to do" return that `runMigrations` never sees. A database whose
 * ledger is a superset of this build's names has nothing *pending* and is still
 * the one the command must refuse.
 */
describe("runMigrate", () => {
  let dir: string;
  let previousSqlitePath = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "courier-migrate-"));
    previousSqlitePath = config.SQLITE_PATH;
    config.SQLITE_PATH = join(dir, "courier.db");
  });

  afterEach(async () => {
    await removeDirWithRetry(dir);
    config.SQLITE_PATH = previousSqlitePath;
  });

  function withDatabase<T>(use: (sqlite: Database) => T): T {
    const sqlite = new Database(join(dir, "courier.db"));
    try {
      return use(sqlite);
    } finally {
      sqlite.close();
    }
  }

  it("applies the chain to a fresh database", async () => {
    await migrate();

    const names = withDatabase((sqlite) =>
      (sqlite.prepare("SELECT name FROM courier_migrations").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    expect(names).toHaveLength(MIGRATIONS.length);
  });

  it("is a no-op on a database that is already current", async () => {
    await migrate();
    const read = () =>
      withDatabase((sqlite) =>
        sqlite.prepare("SELECT name, applied_at FROM courier_migrations ORDER BY name").all(),
      );
    const before = read();

    // The early "All migrations up to date." path: it must not rewrite the rows
    // (a fresh `applied_at` would mean the chain ran again).
    await expect(migrate()).resolves.toBeUndefined();

    expect(read()).toEqual(before);
  });

  it("writes nothing under --dry-run", async () => {
    await migrate({ dryRun: true });

    const tables = withDatabase((sqlite) =>
      (
        sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    expect(tables).toEqual([]);
  });

  it("refuses a database a newer build migrated, even with nothing pending", async () => {
    // Every name this build carries, plus one it does not: `pendingMigrations`
    // is empty, so the refusal has to happen before the early return.
    withDatabase((sqlite) => {
      sqlite.exec("CREATE TABLE courier_migrations (name TEXT PRIMARY KEY, applied_at TEXT)");
      const insert = sqlite.prepare("INSERT INTO courier_migrations (name) VALUES (?)");
      for (const migration of MIGRATIONS) insert.run(migration.name);
      insert.run("20990101000000_from_the_future");
    });

    await expect(migrate()).rejects.toThrow(/does not know.*from_the_future.*upgrade/s);
  });
});

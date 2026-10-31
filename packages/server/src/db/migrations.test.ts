import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import { sortedCopy } from "@courier/shared";
import { appliedMigrationCount, pendingMigrations, runMigrations } from "./migrations";
import { MIGRATIONS } from "./migrations.generated";

const NAMES = MIGRATIONS.map((migration) => migration.name);

function database(): Database {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return sqlite;
}

function recordedNames(sqlite: Database): string[] {
  const rows = sqlite.prepare("SELECT name FROM courier_migrations ORDER BY name").all() as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

function hasTable(sqlite: Database, name: string): boolean {
  // `bun:sqlite` returns null for a missing row, not undefined.
  return sqlite.prepare("SELECT 1 AS found FROM sqlite_master WHERE name = ?").get(name) != null;
}

describe("runMigrations", () => {
  it("applies the whole chain to a fresh database and records every name", () => {
    const sqlite = database();

    expect(pendingMigrations(sqlite)).toEqual([...MIGRATIONS]);
    expect(runMigrations(sqlite)).toBe(MIGRATIONS.length);

    expect(recordedNames(sqlite)).toEqual(sortedCopy(NAMES));
    expect(appliedMigrationCount(sqlite)).toBe(MIGRATIONS.length);
    expect(pendingMigrations(sqlite)).toEqual([]);
    expect(hasTable(sqlite, "api_keys")).toBe(true);
    expect(hasTable(sqlite, "file_versions")).toBe(true);

    // A second run is a no-op.
    expect(runMigrations(sqlite)).toBe(0);
    expect(recordedNames(sqlite)).toHaveLength(MIGRATIONS.length);
  });

  it("records when each migration was applied", () => {
    const sqlite = database();
    runMigrations(sqlite);

    const rows = sqlite.prepare("SELECT applied_at FROM courier_migrations").all() as Array<{
      applied_at: string;
    }>;
    expect(rows.length).toBe(MIGRATIONS.length);
    expect(rows.every((row) => /^\d{4}-\d{2}-\d{2}T/.test(row.applied_at))).toBe(true);
  });

  it("never executes a migration the ledger already records, whatever its SQL says", () => {
    // The identity is the directory name. A database that already recorded the
    // chain is not migrated again — that is what keeps a rebuilt binary, or a
    // rewritten SQL file, from re-running `CREATE TABLE api_keys`.
    const sqlite = database();
    sqlite.exec("CREATE TABLE courier_migrations (name TEXT PRIMARY KEY, applied_at TEXT)");
    for (const name of NAMES) {
      sqlite.prepare("INSERT INTO courier_migrations (name) VALUES (?)").run(name);
    }

    expect(runMigrations(sqlite)).toBe(0);
    expect(hasTable(sqlite, "api_keys")).toBe(false);
  });

  it("refuses a database a newer build has migrated", () => {
    const sqlite = database();
    sqlite.exec("CREATE TABLE courier_migrations (name TEXT PRIMARY KEY, applied_at TEXT)");
    sqlite
      .prepare("INSERT INTO courier_migrations (name) VALUES (?)")
      .run("20990101000000_from_the_future");

    expect(() => runMigrations(sqlite)).toThrowError(/does not know.*from_the_future.*upgrade/s);
    expect(hasTable(sqlite, "api_keys")).toBe(false);
  });

  it("names a pre-release database instead of re-running the chain over it", () => {
    // A database migrated before the name ledger still records hashes in
    // `__drizzle_migrations`; without the preflight it would look unmigrated and
    // die on `CREATE TABLE api_keys` with no explanation.
    const sqlite = database();
    sqlite.exec("CREATE TABLE __drizzle_migrations (hash TEXT PRIMARY KEY, created_at TEXT)");
    sqlite.prepare("INSERT INTO __drizzle_migrations (hash) VALUES ('old')").run();

    expect(() => runMigrations(sqlite)).toThrowError(/predates the migration ledger/);
    expect(hasTable(sqlite, "api_keys")).toBe(false);
  });

  it("does not mistake an empty old ledger for a migrated database", () => {
    const sqlite = database();
    sqlite.exec("CREATE TABLE __drizzle_migrations (hash TEXT PRIMARY KEY, created_at TEXT)");

    expect(runMigrations(sqlite)).toBe(MIGRATIONS.length);
    expect(recordedNames(sqlite)).toHaveLength(MIGRATIONS.length);
  });

  it("names the migration that failed and rolls only that one back", () => {
    const sqlite = database();
    // `vaults` is the third table the first migration creates: its first two
    // statements run, the third fails, and the rollback must undo the two.
    sqlite.exec("CREATE TABLE `vaults` (`id` text PRIMARY KEY)");

    let failure: Error | undefined;
    try {
      runMigrations(sqlite);
    } catch (error) {
      failure = error as Error;
    }

    expect(failure?.message).toContain("migration 20260629162902_adorable_rattler failed");
    expect(failure?.message).toContain("already exists");
    expect(recordedNames(sqlite)).toEqual([]);
    // The two tables the migration had already created are gone with it.
    expect(hasTable(sqlite, "api_keys")).toBe(false);
    expect(hasTable(sqlite, "file_versions")).toBe(false);
  });
});

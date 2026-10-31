import type { Database } from "bun:sqlite";
import { sortedCopy } from "@courier/shared";
import { MIGRATIONS } from "./migrations.generated";

/**
 * Applying the migration chain.
 *
 * A migration is identified by its directory name (`drizzle/<name>/migration.sql`)
 * and nothing else. Editing a migration's SQL therefore does not make it pending
 * again — the failure that matters: a rebuilt binary or a rewritten file looked
 * "unapplied", and re-running it died on the first table it created. The other
 * side of that rule is deliberate: an edit to an already-applied migration has
 * no effect at all, so a schema change is always a new migration.
 *
 * `MIGRATIONS` is generated into the bundle (see `scripts/generate-migrations.ts`),
 * so the binary, the tests and the dev server read the same list.
 *
 * The ledger is one table, `courier_migrations(name TEXT PRIMARY KEY)`, and each
 * migration runs in its own transaction together with its ledger row: the schema
 * and the ledger cannot disagree, and a failure rolls back only that migration.
 */

const LEDGER = "courier_migrations";
/** The pre-release ledger this design replaced; only its existence is inspected. */
const LEGACY_LEDGER = "__drizzle_migrations";
const STATEMENT_SEPARATOR = "--> statement-breakpoint";

/** One migration, as the generated chain describes it. */
export type Migration = (typeof MIGRATIONS)[number];

/** How many migrations this build carries. */
export function knownMigrationCount(): number {
  return MIGRATIONS.length;
}

function hasTable(sqlite: Database, name: string): boolean {
  // `bun:sqlite`'s `.get()` returns null for "no row", not undefined, so compare
  // loosely rather than against undefined.
  return (
    sqlite
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) != null
  );
}

/** The names this database has recorded. A database without a ledger has none. */
function recordedNames(sqlite: Database): Set<string> {
  if (!hasTable(sqlite, LEDGER)) return new Set();
  const rows = sqlite.prepare(`SELECT name FROM ${LEDGER}`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => String(row.name)));
}

/** How many migrations the database has recorded, including ones this build does not carry. */
export function appliedMigrationCount(sqlite: Database): number {
  return recordedNames(sqlite).size;
}

/** The migrations this build carries that the database has not recorded. */
export function pendingMigrations(sqlite: Database): Migration[] {
  const recorded = recordedNames(sqlite);
  return MIGRATIONS.filter((migration) => !recorded.has(migration.name));
}

/** The names recorded in the database that this build does not carry. */
export function unknownMigrationNames(sqlite: Database): string[] {
  const known = new Set(MIGRATIONS.map((migration) => migration.name));
  return sortedCopy([...recordedNames(sqlite)].filter((name) => !known.has(name)));
}

/**
 * Refuse a database this build must not migrate, before anything is written.
 *
 * Two states are named here instead of surfacing as a SQLite error three
 * statements later:
 *
 *   - the ledger holds names this binary does not carry — the database was
 *     migrated by a newer build, and this one must not run an older chain over
 *     it;
 *   - the ledger is missing but the pre-release `__drizzle_migrations` table has
 *     rows — that database would look unmigrated and re-run `CREATE TABLE
 *     api_keys`. It has to be recreated (this project is pre-release: there is
 *     nothing to preserve).
 */
export function assertMigratable(sqlite: Database): void {
  const unknown = unknownMigrationNames(sqlite);
  if (unknown.length > 0) {
    throw new Error(
      `the database has migrations this build does not know (${unknown.join(", ")}); upgrade the binary`,
    );
  }

  if (!hasTable(sqlite, LEGACY_LEDGER) || recordedNames(sqlite).size > 0) return;
  const legacy = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${LEGACY_LEDGER}`).get() as {
    n: number;
  };
  if (legacy.n > 0) {
    throw new Error(
      "this database predates the migration ledger (`courier_migrations`) and still records hashes " +
        "in `__drizzle_migrations`; delete the database file and run the migration again " +
        "(pre-release: there is no data to preserve)",
    );
  }
}

function ensureLedger(sqlite: Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS ${LEDGER} (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
}

function statementsOf(sql: string): string[] {
  return sql
    .split(STATEMENT_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Apply every migration the database has not recorded, oldest first.
 *
 * Returns how many were applied. A migration is never executed twice, whatever
 * its SQL file says now. Throws on the first failure, naming the migration, with
 * that migration's transaction rolled back; a database this build must not touch
 * is refused by {@link assertMigratable}.
 */
export function runMigrations(sqlite: Database): number {
  // Check first: refusing a database must not leave a ledger table behind in it.
  assertMigratable(sqlite);
  ensureLedger(sqlite);

  let applied = 0;
  for (const migration of MIGRATIONS) {
    try {
      sqlite.exec("BEGIN IMMEDIATE");
      // Re-read under the write lock: a second `courier migrate` waits here, and
      // the one that loses the race must find the work already recorded.
      if (recordedNames(sqlite).has(migration.name)) {
        sqlite.exec("COMMIT");
        continue;
      }
      for (const statement of statementsOf(migration.sql)) sqlite.exec(statement);
      sqlite.prepare(`INSERT INTO ${LEDGER} (name) VALUES (?)`).run(migration.name);
      sqlite.exec("COMMIT");
      applied += 1;
    } catch (error) {
      try {
        sqlite.exec("ROLLBACK");
      } catch {
        // There is no transaction to end (`BEGIN` itself failed, or SQLite
        // already rolled back); the original error is the one to report.
      }
      throw new Error(
        `migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return applied;
}

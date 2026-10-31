import { mkdirSync } from "fs";
import { dirname } from "path";
import { Database } from "bun:sqlite";
import { config } from "../config";
import { assertMigratable, pendingMigrations, runMigrations } from "../db/migrations";
import { info } from "../lib/output";

export async function runMigrate(options: { dryRun?: boolean }): Promise<void> {
  mkdirSync(dirname(config.SQLITE_PATH), { recursive: true });

  const sqlite = new Database(config.SQLITE_PATH);
  try {
    // Two `courier migrate` processes — an operator retrying, two deployments
    // overlapping — wait for each other instead of failing on `database is locked`.
    sqlite.exec("PRAGMA busy_timeout = 30000");
    sqlite.exec("PRAGMA journal_mode = WAL");
    sqlite.exec("PRAGMA foreign_keys = ON");

    const pending = pendingMigrations(sqlite);

    // Before "nothing to do": a database whose ledger is a superset of this
    // build's names has nothing *pending* and is still exactly the one this
    // command must refuse — `runMigrations` would only see it if something were
    // left to apply. `--dry-run` must refuse too, or the answer it prints is a lie.
    assertMigratable(sqlite);

    if (pending.length === 0) {
      info("All migrations up to date.");
      return;
    }

    for (const migration of pending) {
      info(`${options.dryRun ? "[pending]" : "  ✓"} ${migration.name}`);
    }

    if (options.dryRun) return;

    const count = runMigrations(sqlite);
    info(`Done: ${count} migration(s) applied.`);
  } finally {
    sqlite.close();
  }
}

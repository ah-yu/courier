import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { config } from "../config";

/** The raw handle, for the few queries that are not worth a Drizzle expression. */
export const sqlite = new Database(config.SQLITE_PATH);
sqlite.exec("PRAGMA foreign_keys = ON");
// Two processes write this file: the service, and a `courier …` command
// deployment tooling runs over SSH (minting its own admin key). WAL allows one
// writer at a time, so without a timeout the rarer writer fails instantly
// instead of waiting out the other one's short transaction.
sqlite.exec("PRAGMA busy_timeout = 5000");

export const db = drizzle({ client: sqlite });

/**
 * Close the underlying SQLite handle. Needed by graceful shutdown paths and by
 * in-process test harnesses, which otherwise cannot delete the database file
 * (Windows keeps it locked while the handle is open).
 */
export function closeDb(): void {
  sqlite.close();
}

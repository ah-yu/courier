import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { sortedCopy } from "@courier/shared";

/**
 * The migration chain is kept **additive where possible**.
 *
 * `runMigrations` records a migration by its directory name in `courier_migrations`
 * and refuses to run a binary that does not know every recorded name, so the *migrate*
 * command is safe either way. What additive changes protect is the service: it never
 * reads the ledger, so an older binary can still be pointed at a database a newer one
 * migrated (a rollback that restores only the binary, or a manual binary swap). New
 * tables, columns and indexes keep that reading working; a dropped column or a rename
 * does not.
 *
 * A change that genuinely cannot be additive is still a real migration; it must be
 * recorded in `EXPLICIT_EXCEPTIONS` with its reason, so a destructive statement is a
 * deliberate decision rather than something that slips in silently. The chain starts
 * from one baseline migration, so the list is empty.
 *
 * `CREATE TABLE`, `CREATE INDEX`, `ADD COLUMN`, `INSERT` and `UPDATE` need no
 * exception; `DROP`, `RENAME`, `DELETE` and other column surgery do.
 */
const ALLOWED_STATEMENT =
  /^\s*(CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX|TRIGGER)|ALTER\s+TABLE\s+\S+\s+ADD\s+(COLUMN\s+)?\S+|INSERT\s+INTO|UPDATE\s+\S+\s+SET)\b/i;

/**
 * Destructive migrations that were deliberately accepted. Every entry needs a
 * reason, and the list is asserted to match real directories, so it cannot rot.
 * Adding one is the explicit path for a change that cannot be additive.
 */
const EXPLICIT_EXCEPTIONS = new Map<string, string>([]);

function drizzleDir(): string {
  return fileURLToPath(new URL("../../drizzle", import.meta.url));
}

/** Every migration directory that actually holds a migration.sql. */
function migrationDirs(): string[] {
  const dir = drizzleDir();
  return sortedCopy(
    readdirSync(dir).filter((name) => existsSync(join(dir, name, "migration.sql"))),
  );
}

function statementsOf(name: string): string[] {
  const sql = readFileSync(join(drizzleDir(), name, "migration.sql"), "utf-8");
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describe("migration chain policy", () => {
  it("has migrations to check", () => {
    expect(migrationDirs().length).toBeGreaterThan(0);
  });

  it("keeps every migration additive unless it is an explicit exception", () => {
    const violations: string[] = [];

    for (const name of migrationDirs()) {
      if (EXPLICIT_EXCEPTIONS.has(name)) continue;
      for (const statement of statementsOf(name)) {
        if (!ALLOWED_STATEMENT.test(statement)) {
          violations.push(`${name}: ${statement.replace(/\s+/g, " ")}`);
        }
      }
    }

    expect(
      violations,
      "破坏性迁移默认应拆成两次发布（先加新列/双写/回填，下一版删旧列）；" +
        "确实要做，请把它加入 EXPLICIT_EXCEPTIONS 并说明原因。",
    ).toEqual([]);
  });

  it("lists only exceptions that still exist, so the exception list cannot rot", () => {
    const dirs = new Set(migrationDirs());
    for (const name of EXPLICIT_EXCEPTIONS.keys()) {
      expect(dirs.has(name), `${name} 已不在 drizzle/ 下，请从例外列表删除`).toBe(true);
    }
  });

  it("requires a reason for every explicit exception", () => {
    // A destructive migration may be deliberate, but never silent: whoever reads
    // the list must see why it was allowed.
    for (const [name, reason] of EXPLICIT_EXCEPTIONS) {
      expect(reason.length, `${name} 的例外理由不能为空`).toBeGreaterThan(0);
    }
  });
});

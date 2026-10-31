#!/usr/bin/env bun
/**
 * Give `bun run dev` a database that matches the migrations.
 *
 * The server refuses to start without one (`src/main.ts`), and a fresh checkout — every
 * new worktree — has none: `data/` is gitignored. Running the migrations first is exactly
 * what the error message tells the user to do, so the dev script does it for them.
 *
 * It runs every time rather than only when the file is missing: `courier migrate` is
 * idempotent ("All migrations up to date", ~200 ms), and a checkout that pulled a new
 * migration would otherwise start the server against the old schema.
 *
 * The generated chain is refreshed first. The server imports
 * `src/db/migrations.generated.ts` directly, so a migration added without regenerating it
 * would be invisible to this very process; the build refuses a stale file, but stopping
 * the dev server for a step a script can do is just friction. The notice it prints says
 * to commit the result.
 *
 * The database path is resolved the way the server resolves it — `SQLITE_PATH`, relative
 * to the server package, then `./data/courier.db` — so an `.env` override is honoured
 * instead of being silently checked in the wrong place.
 */
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { isAbsolute, join, resolve } from "path";

const serverRoot = join(import.meta.dir, "..");
const configured = process.env.SQLITE_PATH?.trim() || "./data/courier.db";
const database = isAbsolute(configured) ? configured : resolve(serverRoot, configured);

const generated = spawnSync(process.execPath, ["scripts/generate-migrations.ts"], {
  cwd: serverRoot,
  stdio: "inherit",
});
if (generated.status !== 0) process.exit(generated.status ?? 1);

if (!existsSync(database)) {
  console.log(`[courier:server] no database at ${database} yet — creating it`);
}

const result = spawnSync(process.execPath, ["src/main.ts", "migrate"], {
  cwd: serverRoot,
  stdio: "inherit",
});
process.exit(result.status ?? 1);

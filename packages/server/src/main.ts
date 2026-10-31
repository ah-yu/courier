#!/usr/bin/env bun
import { existsSync } from "fs";
import { program } from "commander";
import { config } from "./config";

const DB_HELP = "Run 'courier migrate' first to create the database.";

/** Exit with an error if the database has not been created yet. */
function requireDb(): void {
  if (!existsSync(config.SQLITE_PATH)) {
    console.error(`Error: database not found at "${config.SQLITE_PATH}".`);
    console.error(DB_HELP);
    process.exit(1);
  }
}

program.name("courier").description("Obsidian sync server");

program
  .command("version")
  .description("Print this binary's version and build identity")
  .option("--json", "Output as JSON")
  .action(async (options: { json?: boolean }) => {
    const { runVersion } = await import("./commands/version");
    process.exit(await runVersion(options.json ?? false));
  });

program
  .command("start")
  .description("Start the sync server (HTTP + WebSocket)")
  .option("-p, --port <number>", "Server port (default: 3002)")
  .action(async (options: { port?: string }) => {
    requireDb();
    const { startServer } = await import("./commands/start");
    startServer(options);
  });

const apikey = program.command("apikey").description("Manage API keys");

apikey
  .command("list")
  .description("List all API keys")
  .option("--json", "Output as JSON")
  .action(async (options: { json?: boolean }) => {
    requireDb();
    const { runApikeyList } = await import("./commands/apikey");
    const { apikeyCliActions } = await import("./commands/apikey-actions");
    process.exit(await runApikeyList(options.json ?? false, apikeyCliActions));
  });

apikey
  .command("create <name>")
  .description("Create a new API key (prints the raw key, or the record with --json)")
  .option("--json", "Output the created key record as JSON")
  .option("--expires-in <duration>", "Key lifetime, e.g. 30m, 12h, 7d (default: never expires)")
  .option("--scopes <list>", "Comma-separated scopes (admin|status|users); default: admin")
  .action(
    async (name: string, options: { json?: boolean; expiresIn?: string; scopes?: string }) => {
      requireDb();
      const { runApikeyCreate } = await import("./commands/apikey");
      const { apikeyCliActions } = await import("./commands/apikey-actions");
      process.exit(
        await runApikeyCreate(
          name,
          {
            json: options.json ?? false,
            expiresIn: options.expiresIn,
            scopes: options.scopes,
          },
          apikeyCliActions,
        ),
      );
    },
  );

apikey
  .command("delete <id>")
  .description("Revoke an API key")
  .action(async (id: string) => {
    requireDb();
    const { runApikeyDelete } = await import("./commands/apikey");
    const { apikeyCliActions } = await import("./commands/apikey-actions");
    process.exit(await runApikeyDelete(id, apikeyCliActions));
  });

program
  .command("migrate")
  .description("Manage database migrations")
  .option("--dry-run", "List pending migrations without applying them")
  .action(async (options: { dryRun?: boolean }) => {
    const { runMigrate } = await import("./commands/migrate");
    await runMigrate(options);
    process.exit(0);
  });

program.parse();

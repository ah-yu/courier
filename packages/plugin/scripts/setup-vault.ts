#!/usr/bin/env bun
/**
 * One-time setup for the plugin dev loop: builds the plugin, installs the output into
 * this checkout's two development vaults and enables it there.
 *
 * `bun run dev` runs the same installation itself (plus the dev account, see
 * `dev-setup.ts`); this script stays for putting the plugin into the vaults without
 * starting the watcher.
 */
import { spawnSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { devVaults, pluginDir } from "./dev-vaults.ts";

const here = import.meta.dir;
const pkgRoot = join(here, "..");

// 1. Build so dist/main.js exists (fresh checkouts have no output yet).
const build = spawnSync("bun", ["run", "build"], {
  cwd: pkgRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

// 2. Install the built plugin into every development vault and enable it.
for (const vault of devVaults()) {
  const target = pluginDir(vault.path);
  mkdirSync(target, { recursive: true });
  copyFileSync(join(pkgRoot, "dist", "main.js"), join(target, "main.js"));
  copyFileSync(join(pkgRoot, "manifest.json"), join(target, "manifest.json"));
  copyFileSync(join(pkgRoot, "styles.css"), join(target, "styles.css"));

  // Merge (not overwrite) the enabled-community-plugins list.
  const cpFile = join(vault.path, ".obsidian", "community-plugins.json");
  let enabled = [];
  if (existsSync(cpFile)) {
    try {
      const parsed = JSON.parse(readFileSync(cpFile, "utf8"));
      if (Array.isArray(parsed)) enabled = parsed;
    } catch {
      // Unreadable/corrupt file — start fresh rather than aborting.
    }
  }
  if (!enabled.includes("courier")) enabled.push("courier");
  writeFileSync(cpFile, `${JSON.stringify(enabled, null, 2)}\n`);

  console.log(`Installed Courier into ${vault.path} (Obsidian name: ${vault.name})`);
}

console.log(
  "Development vaults ready. Run `bun run --filter @courier/plugin dev`, keep Obsidian open, " +
    "and the Obsidian CLI will hot-reload the plugin after every rebuild.",
);

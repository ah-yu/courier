#!/usr/bin/env bun
/**
 * Bundle the Obsidian plugin with Bun's own bundler.
 *
 * Obsidian loads exactly one file, `dist/main.js`, as CommonJS, with `obsidian`
 * (and Electron's module surface) provided by the app at runtime. That is the
 * whole contract this build has to keep: one CJS file, those specifiers left as
 * `require(...)`, and the plugin class as `module.exports`.
 *
 * `--watch` rebuilds on a change under `src/` and, in development, copies the
 * result into this checkout's two development vaults and asks the running
 * Obsidian to reload the plugin (see `scripts/dev-vaults.ts`).
 */
import { copyFileSync, existsSync, mkdirSync, watch } from "fs";
import { join } from "path";
import { devVaults } from "./dev-vaults.ts";

const pluginDir = join(import.meta.dir, "..");
const prod = process.argv.includes("--production");
const watching = process.argv.includes("--watch");

/** Bundle once. Returns false when the bundler reported an error. */
async function build(): Promise<boolean> {
  const result = await Bun.build({
    entrypoints: [join(pluginDir, "src", "plugin-entry.ts")],
    outdir: join(pluginDir, "dist"),
    naming: "main.js",
    format: "cjs",
    target: "browser",
    // Obsidian supplies these at runtime; bundling them would ship a second copy.
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
    sourcemap: prod ? "none" : "inline",
    minify: prod,
    // One file, as Obsidian's loader expects.
    splitting: false,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    return false;
  }
  return true;
}

/** Copy the built plugin into every development vault's plugin folder. */
function syncToDevVaults(): void {
  const files = [
    { from: join(pluginDir, "dist", "main.js"), to: "main.js" },
    { from: join(pluginDir, "manifest.json"), to: "manifest.json" },
    // Obsidian loads `styles.css` from the plugin folder; it is source, not build output.
    { from: join(pluginDir, "styles.css"), to: "styles.css" },
  ];
  for (const vault of devVaults()) {
    const target = join(vault.path, ".obsidian", "plugins", "courier");
    mkdirSync(target, { recursive: true });
    for (const { from, to } of files) {
      if (existsSync(from)) copyFileSync(from, join(target, to));
    }
  }
}

let cliChecked = false;
let cliAvailable = false;

/** Whether the official Obsidian CLI is on PATH (probed at most once). */
function checkCliAvailable(): boolean {
  if (cliChecked) return cliAvailable;
  cliChecked = true;
  try {
    const probe = Bun.spawnSync(["obsidian", "--version"], { stdout: "ignore", stderr: "ignore" });
    cliAvailable = probe.exitCode === 0;
  } catch {
    cliAvailable = false;
  }
  if (!cliAvailable) {
    console.warn(
      "[courier:dev] obsidian CLI not found on PATH — hot reload disabled. " +
        "Install it / add it to PATH, or set COURIER_DEV_RELOAD=0 to silence this message.",
    );
  }
  return cliAvailable;
}

/** Ask every open development vault to reload the plugin; best effort, never fatal. */
function reloadVaults(): void {
  if (process.env.COURIER_DEV_RELOAD === "0") return;
  if (!checkCliAvailable()) return;
  for (const vault of devVaults()) {
    for (const command of ["plugin:enable", "plugin:reload"]) {
      const child = Bun.spawn(["obsidian", `vault=${vault.name}`, command, "id=courier"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      void child.exited;
    }
  }
}

if (!(await build())) process.exit(1);
if (!prod) {
  syncToDevVaults();
  reloadVaults();
}

if (watching) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(join(pluginDir, "src"), { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (await build()) {
        if (!prod) {
          syncToDevVaults();
          reloadVaults();
        }
      }
    }, 100);
  });
  console.log("[courier:dev] watching src/ for changes");
}

#!/usr/bin/env bun
/**
 * One-time setup for the real-Obsidian end-to-end suite.
 *
 * Creates the two disposable vaults the suite drives, installs the current
 * plugin build into them, and registers them in Obsidian's vault registry
 * (`obsidian.json`, in Electron's per-OS user-data directory — see
 * `src/obsidian/platform.ts`).
 *
 *   bun run e2e:obsidian            # create + register
 *   bun run e2e:obsidian --clean    # unregister + delete
 *
 * ## Why this is a separate, explicit step
 *
 * Obsidian reads its vault registry **only at startup**, and it also writes that
 * file itself. So an entry added while Obsidian runs is ignored, and — worse —
 * can be overwritten by Obsidian. This script therefore refuses to touch the
 * registry unless Obsidian is closed, keeps a backup the first time it writes,
 * and never deletes entries it does not own.
 *
 * Everything after registration goes through the official CLI, including the
 * two steps a brand-new vault needs: giving it a window (the CLI can only run
 * `eval` in a vault that has one) and switching off restricted mode (which
 * otherwise keeps the plugin from loading).
 */
import { execFileSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { appIsRunning, startObsidianApp } from "../src/obsidian/cli.ts";
import { obsidianRegistryPath } from "../src/obsidian/platform.ts";
import {
  E2E_VAULT_ROOT,
  e2eVaults,
  installPluginIntoVault,
  prepareVault,
  repoRoot,
} from "../src/obsidian/vaults.ts";

const clean = process.argv.includes("--clean");

/**
 * Register both vaults as open, so the app opens their windows when it starts.
 *
 * CI has no desktop-file handler for `obsidian://` and no window manager to
 * focus a URI-opened window, so the cold start restores the two vaults itself.
 * Locally the default stays `false`: `prepareVault()` opens only the vault that
 * has no window and never raises one that is already there.
 */
const openVaults = process.env.COURIER_E2E_OPEN_VAULTS === "1";

interface RegistryEntry {
  path: string;
  ts: number;
  open: boolean;
}
interface Registry {
  vaults: Record<string, RegistryEntry>;
  cli?: boolean;
}

function registryPath(): string {
  return obsidianRegistryPath({
    platform: process.platform,
    appData: process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
    home: homedir(),
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
  });
}

/**
 * Read the registry. An empty registry is returned only when the file does not
 * exist yet; an existing-but-unreadable file throws, because silently
 * substituting an empty object would wipe the developer's other vaults.
 */
function readRegistry(path: string): Registry {
  if (!existsSync(path)) return { vaults: {}, cli: true };
  let parsed: Partial<Registry>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as Partial<Registry>;
  } catch (err) {
    throw new Error(
      `Refusing to touch ${path}: it exists but does not parse (${String(err)}). ` +
        `Fix or delete it and re-run.`,
      { cause: err },
    );
  }
  return { vaults: parsed.vaults ?? {}, cli: parsed.cli ?? true };
}

function writeRegistry(path: string, registry: Registry): void {
  const backup = `${path}.e2e-backup`;
  if (existsSync(path) && !existsSync(backup)) copyFileSync(path, backup);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(registry));
}

/**
 * Wait until the app answers the CLI at all.
 *
 * Not "wait until the CLI lists both vaults": Obsidian 1.14 starts on the vault
 * chooser, and the CLI resolves its vault from the **focused window**, so every
 * command fails with `Vault not found.` until some window holds one. Giving the
 * vaults their windows is `prepareVault`'s job (through `obsidian://open`), so this
 * step only has to prove the app is up.
 */
async function waitForApp(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await appIsRunning()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

function buildPlugin(): void {
  console.log("[e2e] building @courier/plugin …");
  execFileSync("bun", ["run", "--filter", "@courier/plugin", "build"], {
    cwd: repoRoot(),
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

const vaults = e2eVaults();
const registryFile = registryPath();
const registry = readRegistry(registryFile);

/**
 * The registry is only rewritten when a wanted vault is missing from it.
 *
 * That is what makes this script idempotent — and it is the reason a re-run works
 * with Obsidian **open**: the app rewrites `obsidian.json` itself, so touching the
 * file underneath it is the one thing that must not happen. A stale entry inside
 * `.e2e-vaults/` (a folder that moved, an older registration) is therefore only
 * cleaned up on a run that also registers, or by `--clean`.
 */
const needsRegistration = vaults.some(
  (vault) => !Object.values(registry.vaults).some((entry) => entry.path === vault.path),
);

/** Drop entries pointing inside our vault root. Entries we do not own are never touched. */
function dropOwnedEntries(): number {
  let removed = 0;
  for (const [id, entry] of Object.entries(registry.vaults)) {
    if (entry.path.startsWith(E2E_VAULT_ROOT)) {
      delete registry.vaults[id];
      removed++;
    }
  }
  return removed;
}

if (clean) {
  if (await appIsRunning()) {
    console.error("[e2e] Obsidian is running — close it first so the folders can be removed.");
    process.exit(1);
  }
  const removed = dropOwnedEntries();
  writeRegistry(registryFile, registry);
  rmSync(E2E_VAULT_ROOT, { recursive: true, force: true });
  console.log(`[e2e] unregistered ${removed} vault(s) and removed ${E2E_VAULT_ROOT}`);
  process.exit(0);
}

if (needsRegistration) {
  if (await appIsRunning()) {
    console.error(
      "[e2e] Obsidian is running, and it only reads its vault list at startup.\n" +
        "      Close Obsidian and re-run `bun run e2e:obsidian` — this script will not edit\n" +
        "      the registry underneath a running Obsidian.",
    );
    process.exit(1);
  }
  dropOwnedEntries();
  for (const vault of vaults) {
    const id = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join(
      "",
    );
    registry.vaults[id] = { path: vault.path, ts: Date.now(), open: openVaults };
    console.log(`[e2e] registered ${vault.name} (${id})`);
  }
  registry.cli = true;
  writeRegistry(registryFile, registry);
  console.log(`[e2e] registry updated (backup: ${registryFile}.e2e-backup)`);
} else {
  console.log("[e2e] both vaults are already registered — leaving the registry alone");
}

buildPlugin();
for (const vault of vaults) {
  mkdirSync(join(vault.path, ".obsidian"), { recursive: true });
  installPluginIntoVault(vault);
  console.log(`[e2e] installed the plugin into ${vault.path}`);
}

if (!(await appIsRunning())) {
  console.log("[e2e] starting Obsidian …");
  startObsidianApp();
}

if (!(await waitForApp(180_000))) {
  console.error("[e2e] Obsidian did not come up — is the CLI enabled (Settings → General)?");
  process.exit(1);
}

for (const vault of vaults) {
  await prepareVault(vault);
  console.log(`[e2e] ${vault.name} is open and its community plugins are enabled`);
}

console.log(`[e2e] ready — vaults live in ${E2E_VAULT_ROOT}`);
console.log("[e2e] run the suite with: bun run verify obsidian");

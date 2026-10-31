#!/usr/bin/env bun
/**
 * Opens this checkout's development vaults in Obsidian at dev start, and makes sure the
 * plugin can actually load there.
 *
 * The names come from `dev-vaults.ts`, so a linked worktree opens *its* pair rather than
 * the primary checkout's: Obsidian routes `obsidian://open?vault=<name>` and the CLI's
 * `vault=<name>` by name, and one name is one folder.
 *
 * Opening is not enough for a vault Obsidian has never seen: it starts in **Restricted
 * Mode**, which silently keeps a community plugin from loading even though
 * `community-plugins.json` lists it. So the second half of this script waits for each
 * vault to answer the official CLI and turns restricted mode off — that is what makes
 * `bun run dev` in a fresh worktree end with a running plugin rather than a disabled one.
 *
 * A vault the app does not know is opened **through the app** (`vault-open` over the
 * renderer's IPC), which registers it immediately. That is what makes the dev loop work
 * while Obsidian is already open for another task; writing the registry file itself only
 * works when the app is closed (see `obsidian-registry.ts`).
 *
 * Best-effort throughout: no Obsidian, no CLI or a slow start only warn. Skip the whole
 * step with `COURIER_DEV_OPEN_VAULTS=0`.
 */
import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { delimiter, join } from "path";
import { devVaults, repoRoot } from "./dev-vaults.ts";
import { obsidianIsRunning, readRegistry, sameVaultPath } from "./obsidian-registry.ts";

const VAULT_READY_MS = 60_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.env.COURIER_DEV_OPEN_VAULTS === "0") {
  process.exit(0);
}

/** What `dev-setup.ts` remembered about the dev vault (see its `ensureVault`). */
function devCredential() {
  try {
    const state = JSON.parse(readFileSync(join(repoRoot(), ".courier-dev", "dev.json"), "utf8"));
    if (typeof state.vaultId === "string" && typeof state.encryptionKeyB64 === "string") {
      return { vaultId: state.vaultId, encryptionKeyB64: state.encryptionKeyB64 };
    }
  } catch {
    // No state yet: the vault will ask for its password once.
  }
  return null;
}

/**
 * The official CLI: `obsidian` elsewhere, and on Windows the `Obsidian.com` redirector
 * that ships beside the app. Resolved to a path so the child needs no shell (a shell
 * would have to quote the arguments, and the runtime warns about exactly that).
 */
function resolveCli() {
  if (process.env.COURIER_OBSIDIAN_CLI) return process.env.COURIER_OBSIDIAN_CLI;
  if (process.platform !== "win32") return "obsidian";
  const names = ["Obsidian.com", "obsidian.exe", "Obsidian.exe"];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      if (existsSync(join(dir, name))) return join(dir, name);
    }
  }
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const fallback = join(local, "Programs", "Obsidian", "Obsidian.com");
    if (existsSync(fallback)) return fallback;
  }
  return null;
}

const CLI = resolveCli();

function openerCommand(uri) {
  if (process.platform === "win32") {
    // `start "" "obsidian://…"` via cmd.exe (no shell:true → no DEP0190 noise).
    return ["cmd", ["/c", "start", "", uri]];
  }
  if (process.platform === "darwin") {
    return ["open", [uri]];
  }
  return ["xdg-open", [uri]];
}

function cli(args) {
  if (CLI === null) return { status: -1, stdout: "", stderr: "" };
  return spawnSync(CLI, args, {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
}

/**
 * Wait for one vault to answer, then leave it able to run the plugin.
 *
 * `plugins:restrict off` reloads the vault's window the first time, so the plugin is
 * enabled and reloaded afterwards rather than in the same breath.
 */
async function prepareVault(vault) {
  const deadline = Date.now() + VAULT_READY_MS;
  while (Date.now() < deadline) {
    if (cli([`vault=${vault.name}`, "plugins:restrict", "off"]).status === 0) {
      await delay(1_500);
      cli([`vault=${vault.name}`, "plugin:enable", "id=courier"]);
      cli([`vault=${vault.name}`, "plugin:reload", "id=courier"]);
      console.log(`[courier:dev] ${vault.name} is open and its community plugins are enabled`);
      unlockVault(vault);
      return;
    }
    await delay(1_000);
  }
  console.warn(
    `[courier:dev] ${vault.name} never answered the Obsidian CLI — if it is open, enable ` +
      "community plugins there once (Settings → Community plugins → Restricted mode off).",
  );
}

/**
 * Store the vault key where the plugin keeps a remembered unlock.
 *
 * Without this, the first start of every fresh vault stops at its password dialog — one
 * per vault, in every new worktree. `dev-setup.ts` derived the key already, and the
 * harness the real-Obsidian suite uses writes the same record, so this is the same state
 * a user produces by typing the password once.
 */
function unlockVault(vault) {
  const credential = devCredential();
  if (!credential) return;
  const code =
    `(async()=>{app.saveLocalStorage('courier-vault-credential', ${JSON.stringify(credential)});` +
    "return true})().then(r=>'OK:'+JSON.stringify(r),e=>'ERR:'+(e&&e.message?e.message:String(e)))";
  const saved = cli([`vault=${vault.name}`, "eval", `code=${code}`]);
  if (saved.status !== 0 || !(saved.stdout ?? "").includes("OK:")) {
    console.warn(
      `[courier:dev] could not store the vault key in ${vault.name}; unlock it once with the ` +
        "dev password instead.",
    );
    return;
  }
  cli([`vault=${vault.name}`, "plugin:reload", "id=courier"]);
  console.log(`[courier:dev] ${vault.name} unlocked with the development vault key`);
}

/**
 * Open a vault the app does not know yet **through the app itself**.
 *
 * Obsidian owns its vault list and reads the file only at startup, so a registry entry
 * written under a running app is ignored and can be overwritten. Its main process does
 * answer `vault-open` over the renderer's IPC — the same call the vault switcher makes —
 * and that adds the vault for real. This is what lets `bun run dev` run in a worktree while
 * Obsidian is already open for another task, instead of requiring the app to be closed
 * everywhere.
 */
function openInRunningApp(vault) {
  if (CLI === null) return false;
  const path = JSON.stringify(vault.path.replace(/\\/g, "/"));
  const code = `window.electron.ipcRenderer.sendSync("vault-open",${path},false)`;
  const result = cli(["eval", `code=${code}`]);
  if (result.status !== 0) return false;
  // `eval` prints the value it got: `=> true` means the app opened (and registered) it.
  return /=>\s*true\b/.test(result.stdout ?? "");
}

/** Wait for the app to answer `eval`; a cold start takes a few seconds. */
async function waitForCli(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cli(["eval", "code=1"]).status === 0) return true;
    await delay(1_000);
  }
  return false;
}

let registered = null;
try {
  registered = Object.values(readRegistry().vaults as Record<string, { path: string }>).map(
    (entry) => entry.path,
  );
} catch {
  // An unreadable registry is not a reason to skip opening; it only costs the hint.
}

const running = obsidianIsRunning();
/** Vaults the running app opened for us, which therefore registered them too. */
const openedByApp = new Set();
const unregistered = [];

for (const vault of devVaults()) {
  const known = registered === null || registered.some((path) => sameVaultPath(path, vault.path));
  if (!known) {
    unregistered.push(vault);
    continue;
  }
  const uri = `obsidian://open?vault=${encodeURIComponent(vault.name)}`;
  const [bin, args] = openerCommand(uri) as [string, string[]];
  const child = spawn(bin, args, { stdio: "ignore" });
  child.on("error", (err) => {
    console.warn(`[courier:dev] could not open ${vault.name} in Obsidian: ${err.message}`);
  });
  child.on("close", (code) => {
    if (code !== 0) {
      console.warn(
        `[courier:dev] opening ${vault.name} in Obsidian failed (${bin} exited ${code})`,
      );
    } else {
      console.log(`[courier:dev] opened ${vault.name} in Obsidian (${uri})`);
    }
  });
}

if (unregistered.length > 0) {
  if (!running) {
    for (const vault of unregistered) {
      console.warn(
        `[courier:dev] ${vault.name} is not registered with Obsidian — restart Obsidian once ` +
          "after `bun run dev` registered it, and it opens automatically.",
      );
    }
  } else if (!(await waitForCli())) {
    console.warn(
      "[courier:dev] Obsidian is running but its CLI never answered, so the new vaults were " +
        "not opened; close it once and run `bun run dev` again to register them.",
    );
  } else {
    for (const vault of unregistered) {
      if (openInRunningApp(vault)) {
        openedByApp.add(vault.name);
        console.log(`[courier:dev] ${vault.name} opened and registered in the running Obsidian`);
      } else {
        console.warn(
          `[courier:dev] could not open ${vault.name} through the running Obsidian — close it ` +
            "once, then run `bun run dev` again to register the vault.",
        );
      }
    }
  }
}

if (CLI === null) {
  console.warn(
    "[courier:dev] the Obsidian CLI was not found, so the vaults' community plugins were " +
      "left as they are (set COURIER_OBSIDIAN_CLI to its path to have them enabled).",
  );
} else {
  // Obsidian may be starting up right now; this waits for each window rather than asking
  // once and giving up. A vault that is neither registered nor opened through the app
  // cannot be reached by name, so waiting for it would only stall the watcher.
  for (const vault of devVaults()) {
    const known =
      registered === null ||
      registered.some((path) => sameVaultPath(path, vault.path)) ||
      openedByApp.has(vault.name);
    if (!known) continue;
    await prepareVault(vault);
  }
}

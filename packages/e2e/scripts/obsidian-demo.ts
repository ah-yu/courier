#!/usr/bin/env bun
/**
 * Live demonstration of the sync path between the two disposable Obsidian
 * vaults - the tangible version of what `bun run verify obsidian` asserts.
 *
 *   bun run e2e:obsidian:demo              # scripted run, prints a transcript, cleans up
 *   bun run e2e:obsidian:demo -- --hold    # seed one note, then stay alive so you can
 *                                       # edit in the two Obsidian windows yourself
 *   bun run e2e:obsidian:demo -- --keep    # leave the demo notes in place afterwards
 *
 * Everything is real: the real server (a throwaway SQLite database in the temp
 * directory), the real plugin loaded in two real vaults, real vault events, real
 * `requestUrl`, real websocket. The "other vault" content is read back through
 * the CLI's own `read` command, so what you see is the vault's file, not the
 * plugin's opinion of it.
 *
 * Requires the disposable vaults to be registered once: `bun run e2e:obsidian`.
 * Run it in your own terminal - it wants to stay in the foreground and be
 * watched.
 */
import { execFileSync } from "child_process";
import { readVaultFile, reloadCourierPlugin } from "../src/obsidian/cli.ts";
import {
  ObsidianVault,
  configurePluginHost,
  pausePluginHost,
  type PluginHostSetup,
} from "../src/obsidian/plugin-control.ts";
import {
  e2eVaults,
  installPluginIntoVault,
  prepareVault,
  repoRoot,
  resetVault,
  type E2eVault,
} from "../src/obsidian/vaults.ts";
import { startTestServer, type TestServer } from "../src/harness/server.ts";
import { createTestVault, makeVaultMaterial } from "../src/harness/vault.ts";
import { vaultHistory } from "../src/harness/api.ts";

const hold = process.argv.includes("--hold");
const keep = process.argv.includes("--keep");
/** How long to wait for a single change to cross over before giving up. */
const STEP_TIMEOUT_MS = Number(process.env.COURIER_DEMO_STEP_TIMEOUT_MS ?? 20_000);
/** Wall-clock start, so every line can carry "how far in are we". */
const T0 = Date.now();

/** `HH:MM:SS.mmm` plus `+N.Ns` since start - the transcript is about timing. */
function stamp(): string {
  return `${new Date().toISOString().slice(11, 23)}  +${((Date.now() - T0) / 1000).toFixed(1)}s`;
}

function log(message = ""): void {
  console.log(`${stamp()}  ${message}`);
}

function rule(title: string): void {
  log("");
  // ASCII only: box-drawing characters survive neither a Windows console code
  // page nor every shell round-trip.
  log(`== ${title} ${"=".repeat(Math.max(0, 56 - title.length))}`);
}

/** Render content for the transcript: newlines visible, length bounded. */
function show(content: string | null): string {
  if (content === null) return "(missing)";
  return JSON.stringify(content.length > 120 ? `${content.slice(0, 120)}...` : content);
}

/**
 * Poll `predicate` until it holds, printing a heartbeat every few seconds so a
 * slow step can never look like a hung one. Returns how long it took.
 */
async function waitUntil(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<number> {
  const started = Date.now();
  let nextHeartbeat = started + 4_000;
  for (;;) {
    if (await predicate()) return Date.now() - started;
    const now = Date.now();
    if (now - started >= timeoutMs) {
      throw new Error(`${label}: gave up after ${timeoutMs} ms`);
    }
    if (now >= nextHeartbeat) {
      nextHeartbeat = now + 4_000;
      log(`   ... still waiting (${((now - started) / 1000).toFixed(0)}s / ${timeoutMs / 1000}s)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

let server: TestServer | undefined;
let disposable: [E2eVault, E2eVault] | undefined;
let cleaning = false;

/** Stop both hosts and wipe the vaults (unless `--keep`). */
async function cleanup(): Promise<void> {
  if (cleaning) return;
  cleaning = true;
  if (!disposable) return;
  for (const vault of disposable) {
    try {
      await pausePluginHost(vault.name);
      if (!keep) await resetVault(vault);
    } catch {
      // Best effort - a demo must never fail on the way out.
    }
  }
  await server?.close();
}

process.on("SIGINT", () => {
  log("");
  log("Ctrl+C - cleaning up ...");
  void cleanup().then(() => process.exit(0));
});

async function main(): Promise<void> {
  disposable = e2eVaults();
  const [dirA, dirB] = disposable;
  const vaultA = new ObsidianVault(dirA.name);
  const vaultB = new ObsidianVault(dirB.name);
  const PATH = "sync-demo.md";

  log(`vault A = ${dirA.name}  (${dirA.path})`);
  log(`vault B = ${dirB.name}  (${dirB.path})`);
  log(`each change waits at most ${STEP_TIMEOUT_MS} ms (COURIER_DEMO_STEP_TIMEOUT_MS)`);
  log("setup is ~6s (starts Obsidian if it is closed, rebuilds and rebinds the plugin);");
  log("each sync step is then well under 200 ms.");

  // == Setup ==
  rule("setup 1/4: make both vaults usable (starts Obsidian if it is closed)");
  for (const vault of disposable) {
    const started = Date.now();
    await prepareVault(vault);
    log(`ok  ${vault.name} ready (${Date.now() - started} ms)`);
  }

  rule("setup 2/4: build and install the current plugin");
  {
    const started = Date.now();
    execFileSync("bun", ["run", "--filter", "@courier/plugin", "build"], {
      cwd: repoRoot(),
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    log(`ok  built (${Date.now() - started} ms)`);
  }

  rule("setup 3/4: wipe both vaults and reload the plugin");
  for (const vault of disposable) {
    const started = Date.now();
    installPluginIntoVault(vault);
    await resetVault(vault);
    await reloadCourierPlugin(vault.name);
    log(`ok  ${vault.name} empty, plugin reloaded (${Date.now() - started} ms)`);
  }

  rule("setup 4/4: start a throwaway server and bind both vaults to it");
  server = await startTestServer("obsidian demo user");
  const material = await makeVaultMaterial();
  const remote = await createTestVault(server, "Obsidian Demo", material);
  log(`server http://127.0.0.1:${new URL(server.serverUrl).port}  (temp db ${server.rootDir})`);
  log(`remote vault "${remote.name}" = ${remote.id}`);

  const setup: Omit<PluginHostSetup, "deviceName"> = {
    serverUrl: server.serverUrl,
    userKey: server.userKey,
    vaultId: remote.id,
    vaultName: remote.name,
    encryptionSalt: material.salt,
    password: material.password,
  };
  {
    const started = Date.now();
    const a = await configurePluginHost(dirA.name, { ...setup, deviceName: "demo-A" });
    log(`ok  ${dirA.name} bound and started, device=${a.deviceName} (${Date.now() - started} ms)`);
  }
  {
    const started = Date.now();
    const b = await configurePluginHost(dirB.name, { ...setup, deviceName: "demo-B" });
    log(`ok  ${dirB.name} bound and started, device=${b.deviceName} (${Date.now() - started} ms)`);
  }

  /** Write in `from`, wait for it to show up in `to`, print what `to` holds. */
  async function transfer(label: string, from: ObsidianVault, to: ObsidianVault, body: string) {
    rule(label);
    log(`write into ${from.name}  ->  ${PATH}`);
    log(`   ${show(body)}`);
    await from.write(PATH, body);
    const started = Date.now();
    await waitUntil(
      `${to.name} never received ${PATH}`,
      async () => (await to.read(PATH)) === body,
      STEP_TIMEOUT_MS,
    );
    log(`${to.name} reads back (via the CLI's own 'read', not the plugin):`);
    log(`   ${show(await readVaultFile(to.name, PATH))}`);
    log(`ok  arrived in ${Date.now() - started} ms`);
    const files = await vaultHistory(server!, remote.id);
    const versions = files.find((file) => file.versions.length > 0)?.versions.length ?? 0;
    log(`    server side: ${files.length} fileId(s), this file has ${versions} version(s)`);
  }

  // == Interactive: seed one note, then hand over ==
  if (hold) {
    rule("watch the other window: writing the starter note now");
    const body = `# sync demo\n\nthis line was written in ${dirA.name}.\n`;
    await vaultA.write(PATH, body);
    log(`wrote ${PATH} into ${dirA.name}; waiting for it to show up in ${dirB.name} ...`);
    const started = Date.now();
    await waitUntil(
      `${dirB.name} never received ${PATH}`,
      async () => (await vaultB.read(PATH)) === body,
      STEP_TIMEOUT_MS,
    );
    log(`ok  arrived in ${dirB.name} after ${Date.now() - started} ms`);

    rule("your turn");
    log(`The two windows are "${dirA.name}" and "${dirB.name}".`);
    log(`Edit ${PATH} in either one, or create a new .md - it shows up on the other side.`);
    log(`server still running: ${server.serverUrl}`);
    log("Ctrl+C to finish and clean up (both vaults get wiped).");
    await new Promise<void>(() => {
      // Never resolves: the SIGINT handler does the cleanup.
    });
    return;
  }

  // == Scripted transcript ==
  await transfer("1. create a note in A", vaultA, vaultB, "# first version from A\n\nhello");
  await transfer("2. edit it in A", vaultA, vaultB, "# second version\n\nedited in A");
  await transfer("3. edit it in B (the other direction)", vaultB, vaultA, "# edited in B\n\n");

  rule("4. rename in A: sync-demo.md -> renamed-demo.md");
  await vaultA.rename(PATH, "renamed-demo.md");
  const renameStarted = Date.now();
  await waitUntil(
    "B did not follow the rename",
    async () => (await vaultB.read("renamed-demo.md")) === "# edited in B\n\n",
    STEP_TIMEOUT_MS,
  );
  log(`ok  B follows the rename after ${Date.now() - renameStarted} ms`);
  log(`    does B still have the old path? ${await vaultB.exists(PATH)}`);

  rule("5. delete renamed-demo.md in A");
  await vaultA.remove("renamed-demo.md");
  const deleteStarted = Date.now();
  await waitUntil(
    "B did not apply the delete",
    async () => !(await vaultB.exists("renamed-demo.md")),
    STEP_TIMEOUT_MS,
  );
  log(`ok  delete propagated after ${Date.now() - deleteStarted} ms`);
  log(`    markdown files left in B: ${JSON.stringify(await vaultB.list())}`);

  rule("done");
  log(`total wall clock: ${((Date.now() - T0) / 1000).toFixed(1)}s`);
  log(keep ? "demo notes kept (--keep)" : "both vaults will be wiped again");
  await cleanup();
  log("For the hands-on version run: bun run e2e:obsidian:demo -- --hold");
  // The server module keeps a module-level interval (rate limiting) alive, so
  // the event loop would never drain on its own. The test runner force-exits its workers,
  // which is why this only shows up when running the harness standalone.
  process.exit(0);
}

main().catch(async (err) => {
  console.error(`${stamp()}  demo failed:`, err);
  await cleanup();
  process.exit(1);
});

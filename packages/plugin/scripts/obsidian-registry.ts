// Obsidian's vault registry, as far as the dev loop needs it.
//
// Obsidian reads `obsidian.json` **at startup** and rewrites it from its own state, so a
// vault added to the file while the app runs is ignored — and can be overwritten.
// Registration through this module therefore happens only when Obsidian is closed; the
// caller reports what to do when it is not. A running app can still be asked to open the
// folder itself, which registers it (`open-vaults.ts` does that via `vault-open`).
// Entries this script did not add are never touched.
import { spawnSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

/** Obsidian's user-data directory differs per platform; this mirrors its own lookup. */
export function registryPath({
  platform = process.platform,
  env = process.env,
  home = homedir(),
} = {}) {
  if (platform === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "obsidian", "obsidian.json");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "obsidian", "obsidian.json");
  }
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(configHome, "obsidian", "obsidian.json");
}

/** Read the registry; a missing file is an empty registry, an unreadable one throws. */
export function readRegistry(path = registryPath()) {
  if (!existsSync(path)) return { vaults: {}, cli: true };
  const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  try {
    const parsed = JSON.parse(raw);
    return { vaults: parsed.vaults ?? {}, cli: parsed.cli ?? true };
  } catch (err) {
    throw new Error(
      `Refusing to touch ${path}: it exists but does not parse (${String(err)}). ` +
        "Fix or delete it and re-run.",
      { cause: err },
    );
  }
}

/** Write the registry, keeping one backup of what was there first. */
export function writeRegistry(registry, path = registryPath()) {
  const backup = `${path}.dev-backup`;
  if (existsSync(path) && !existsSync(backup)) copyFileSync(path, backup);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(registry));
}

/** Best-effort: is an Obsidian window open right now? */
export function obsidianIsRunning() {
  try {
    if (process.platform === "win32") {
      const { stdout } = spawnSync("tasklist", ["/FI", "IMAGENAME eq Obsidian.exe", "/NH"], {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
      });
      return /obsidian\.exe/i.test(stdout ?? "");
    }
    return (
      spawnSync("pgrep", ["-f", "Obsidian"], { stdio: "ignore", timeout: 15_000 }).status === 0
    );
  } catch {
    // Unknown is not "closed": registration is not worth racing the app for.
    return true;
  }
}

/**
 * A path as it compares: one separator, no trailing one, and — on Windows, where the
 * filesystem does — no case. Obsidian stores whatever spelling a vault was added with, so
 * `D:/vaults/a` and `D:\vaults\a` are the same folder and must not both be registered.
 */
function comparablePath(value) {
  const folded = String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return process.platform === "win32" ? folded.toLowerCase() : folded;
}

export function sameVaultPath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

/**
 * Register the given vault folders.
 *
 * Returns the paths that were added, and whether the app has to be restarted for it to
 * see them. Nothing is written while Obsidian runs: it owns the file and reads it only at
 * startup.
 */
export function ensureRegistered(paths, { path = registryPath() } = {}) {
  const registry = readRegistry(path);
  const known = Object.values(registry.vaults as Record<string, { path: string }>).map(
    (entry) => entry.path,
  );
  const missing = paths.filter(
    (vaultPath) => !known.some((registered) => sameVaultPath(registered, vaultPath)),
  );
  if (missing.length === 0) return { added: [], restart: false };

  if (obsidianIsRunning()) return { added: [], restart: true, blocked: true };

  for (const vaultPath of missing) {
    const id = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join(
      "",
    );
    registry.vaults[id] = { path: vaultPath, ts: Date.now(), open: false };
  }
  registry.cli = true;
  writeRegistry(registry, path);
  return { added: missing, restart: true };
}

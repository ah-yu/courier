// Where the two development vaults live, and the names Obsidian knows them by.
//
// Two checkouts of this repository each have fixtures, so the **name** cannot be
// `vault_a` in both: Obsidian routes `obsidian://open?vault=<name>` and the CLI's
// `vault=<name>` by name, and one name resolves to one registered folder. A linked
// worktree therefore gets its own suffixed pair (`vault_a-fix-cli-status-lag`), while
// the primary checkout keeps the canonical names the documents use (`vault_a`).
//
// Everything that touches the fixtures — the dev bootstrap, the Obsidian URI opener, the
// `scripts/build.ts` output copy and `setup:vault` — reads the pair from here, so a name can never
// drift between them.
import { existsSync, statSync } from "fs";
import { basename, join } from "path";

const here = import.meta.dir;

/** Absolute path of this checkout's repository root (`packages/plugin/scripts` → root). */
export function repoRoot() {
  return join(here, "..", "..", "..");
}

/**
 * `""` for the primary checkout, the directory name for a linked worktree.
 *
 * `.git` is a directory in the primary checkout and a file (`gitdir: …`) in a linked
 * worktree, so this needs no git process and works from any cwd.
 */
export function checkoutSlug(root = repoRoot()) {
  const dotGit = join(root, ".git");
  if (!existsSync(dotGit) || !statSync(dotGit).isFile()) return "";
  return basename(root)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/** The two development vaults: absolute folder, Obsidian name and device label. */
export function devVaults() {
  const root = repoRoot();
  const slug = checkoutSlug(root);
  const suffix = slug ? `-${slug}` : "";
  const label = slug || "main";
  return [
    {
      key: "a",
      path: join(root, `vault_a${suffix}`),
      name: process.env.COURIER_OBSIDIAN_VAULT_A ?? `vault_a${suffix}`,
      deviceName: `${label} A`,
    },
    {
      key: "b",
      path: join(root, `vault_b${suffix}`),
      name: process.env.COURIER_OBSIDIAN_VAULT_B ?? `vault_b${suffix}`,
      deviceName: `${label} B`,
    },
  ];
}

/** Where one vault's copy of the plugin lives. */
export function pluginDir(vaultPath) {
  return join(vaultPath, ".obsidian", "plugins", "courier");
}

/**
 * How a restore that cannot use its original path names the copy.
 *
 * Deliberately free of both `obsidian` and the engine: it is the rule itself — `-n`
 * before the extension, `-1` first, raised until the path is free — and the surfaces
 * that use it (the recycle bin, the version-history modal) only supply the "is this
 * path free" question. That keeps the rule unit-testable, which is what the plugin's
 * other pure rules do (`settings-stage.ts`, `recycle-bin-row.ts`).
 */

/** How many `-n` names are tried before the first one is offered anyway. */
export const MAX_RESTORE_NAME_ATTEMPTS = 50;

/** A vault path split into the folder it lives in and its file name. */
export function splitVaultPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { dir: "", name: path }
    : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

/**
 * The `n`-th name a restore of `plainPath` would use: `-n` goes before the
 * extension, so `notes/hero.md` becomes `notes/hero-1.md` and a file with no
 * extension becomes `LICENSE-1`.
 *
 * A leading dot is not an extension separator (`.gitignore` → `.gitignore-1`), the
 * same rule as the engine's `extensionOf`.
 */
export function numberedRestorePath(plainPath: string, attempt: number): string {
  const { dir, name } = splitVaultPath(plainPath);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  const numbered = `${stem}-${attempt}${extension}`;
  return dir ? `${dir}/${numbered}` : numbered;
}

/**
 * The first free `-n` path for a restore whose own path is taken — the default the
 * dialog opens with. Bounded, so a vault full of identically named copies cannot spin
 * here; when every candidate is taken the first one is offered anyway and the dialog's
 * own validation has the last word.
 */
export async function freeRestorePath(
  plainPath: string,
  isFree: (path: string) => Promise<boolean>,
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_RESTORE_NAME_ATTEMPTS; attempt++) {
    const candidate = numberedRestorePath(plainPath, attempt);
    if (await isFree(candidate)) return candidate;
  }
  return numberedRestorePath(plainPath, 1);
}

import { promises as fs, watch } from "fs";
import path from "path";
import type { SyncLeaseStore } from "@courier/engine";

/**
 * Watch the lease directory and call `onChange` when the holder removes it.
 *
 * Any change wakes the waiter; release removes files in several steps and a platform may
 * report only one of them (even just `owner.json`). Renewals therefore cause an occasional
 * retry, which is cheaper than missing a release and waiting for the fallback timer.
 * Returns a cleanup function and falls back to a no-op when the directory cannot be
 * watched (the caller's timer still covers that case).
 */
export function watchLeaseRelease(
  vaultRoot: string,
  onChange: () => void,
  watchFn: typeof watch = watch,
): () => void {
  try {
    const watcher = watchFn(
      path.join(path.resolve(vaultRoot), ".courier"),
      { persistent: false },
      () => onChange(),
    );
    watcher.on("error", () => {});
    return () => watcher.close();
  } catch {
    return () => {};
  }
}

/**
 * The lease store for a headless machine, over the real vault filesystem.
 *
 * `mkdir` is the atomic primitive: two `courier-cli run --vault <id>` processes (or a CLI
 * and nothing else) cannot both create `.courier/sync-lease`. Paths arrive vault-relative,
 * so they are resolved against the vault root and rejected if they escape it.
 */
export class LeaseStore implements SyncLeaseStore {
  private readonly root: string;

  constructor(vaultRoot: string) {
    this.root = path.resolve(vaultRoot);
  }

  private resolve(relative: string): string {
    const joined = path.resolve(this.root, relative);
    if (joined !== this.root && !joined.startsWith(`${this.root}${path.sep}`)) {
      throw new Error(`lease path escapes vault root: ${relative}`);
    }
    return joined;
  }

  async ensureDir(relative: string): Promise<void> {
    await fs.mkdir(this.resolve(relative), { recursive: true });
  }

  async tryCreateDir(relative: string): Promise<boolean> {
    try {
      await fs.mkdir(this.resolve(relative));
      return true;
    } catch (err) {
      if ((err as Bun.SystemError).code === "EEXIST") return false;
      throw err;
    }
  }

  async tryRename(from: string, to: string): Promise<boolean> {
    try {
      await fs.rename(this.resolve(from), this.resolve(to));
      return true;
    } catch {
      return false;
    }
  }

  async readFile(relative: string): Promise<string | null> {
    try {
      return await fs.readFile(this.resolve(relative), "utf-8");
    } catch (err) {
      if ((err as Bun.SystemError).code === "ENOENT") return null;
      throw err;
    }
  }

  async writeFile(relative: string, data: string): Promise<void> {
    await fs.writeFile(this.resolve(relative), data, "utf-8");
  }

  async removeFile(relative: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(relative));
    } catch (err) {
      if ((err as Bun.SystemError).code !== "ENOENT") throw err;
    }
  }

  async removeDir(relative: string): Promise<void> {
    await fs.rm(this.resolve(relative), { recursive: true, force: true });
  }

  async stat(relative: string): Promise<{ mtimeMs: number } | null> {
    try {
      const info = await fs.stat(this.resolve(relative));
      return { mtimeMs: info.mtimeMs };
    } catch (err) {
      if ((err as Bun.SystemError).code === "ENOENT") return null;
      throw err;
    }
  }
}

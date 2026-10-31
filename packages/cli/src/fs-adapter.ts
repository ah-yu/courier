import { promises as fs } from "fs";
import type { FileHandle } from "fs/promises";
import path from "path";
import {
  DEFAULT_SYNC_SCOPE,
  isConflictFile,
  isSyncableDir,
  isSyncablePath,
  withinFileSizeCap,
  type FileStamp,
  type SyncAdapter,
  type SyncHasher,
  type SyncScope,
  type SyncWriteStream,
} from "@courier/engine";
import { sortedCopy } from "@courier/shared";
import { t } from "./i18n";

/**
 * SyncAdapter over the real filesystem for headless machines (VPS/NAS/desktop
 * without Obsidian open).
 *
 * Markdown and `.canvas` anywhere outside dot-folders, the file types the scope allows
 * (images/audio/video/PDF by default), and — for any scope that enables them — the
 * config folder's settings files. The CLI's own scope never enables a config-folder
 * group (see `syncScopeOf`), so in production every `.obsidian/` subfolder is pruned and
 * the folder's root files are filtered out of the listing.
 * `*.conflict.*` files are excluded from sync and reported separately.
 */
export class FsAdapter implements SyncAdapter {
  constructor(
    private root: string,
    private readonly scope: SyncScope = DEFAULT_SYNC_SCOPE,
  ) {}

  private resolve(p: string): string {
    // Paths are vault-relative; resolve against the vault root and reject
    // traversal outside it.
    const joined = path.join(this.root, p);
    if (
      !joined.startsWith(path.resolve(this.root) + path.sep) &&
      joined !== path.resolve(this.root)
    ) {
      throw new Error(t("cli.error.pathEscapes", { path: p }));
    }
    return joined;
  }

  /**
   * Every file in the vault, vault-relative and sorted.
   *
   * A folder the scope cannot sync is never descended into, so a vault that does
   * not sync plugins does not walk `.obsidian/plugins/**` on every pass — the
   * config folder is where the bulk of a vault's small files live.
   */
  private async walk(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!isSyncableDir(relPath, this.scope)) continue;
          await walk(path.join(dir, entry.name), relPath);
        } else if (entry.isFile()) {
          out.push(relPath.replace(/\\/g, "/"));
        }
      }
    };
    await walk(this.root, "");
    return sortedCopy(out);
  }

  async listSyncableFiles(): Promise<string[]> {
    return (await this.walk()).filter((p) => isSyncablePath(p, this.scope));
  }

  /**
   * The files under the folders this machine excludes — a listing only, and only used
   * when a tracked file has gone missing and the engine is deciding whether that was a
   * deletion or a move into one of those folders.
   *
   * The excluded folders themselves are walked (their whole point is that no other walk
   * enters them), outermost first; an entry already inside another entry is skipped so
   * the same file is not listed twice.
   */
  async listExcludedFiles(): Promise<string[]> {
    if (this.scope.excludedFolders.length === 0) return [];
    const out: string[] = [];
    const walked: string[] = [];
    const folders = sortedCopy(
      this.scope.excludedFolders,
      (left, right) => left.split("/").length - right.split("/").length,
    );
    for (const folder of folders) {
      if (walked.some((parent) => folder.startsWith(`${parent}/`))) continue;
      walked.push(folder);
      await this.walkExcluded(folder, out);
    }
    return sortedCopy(out);
  }

  /** Collect the files under one excluded folder, without descending elsewhere. */
  private async walkExcluded(dir: string, out: string[]): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(this.resolve(dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await this.walkExcluded(relPath, out);
      else if (entry.isFile() && !isConflictFile(relPath)) out.push(relPath);
    }
  }

  /**
   * Files this machine would sync if they were not larger than the scope's cap, with
   * their sizes. `courier-cli status` reports them: a file the daemon never uploads is
   * otherwise invisible (there is no UI to notice it in).
   */
  async listOversizeFiles(): Promise<Array<{ path: string; sizeBytes: number }>> {
    if (this.scope.maxFileBytes === 0) return [];
    const out: Array<{ path: string; sizeBytes: number }> = [];
    for (const file of await this.listSyncableFiles()) {
      const stamp = await this.statFile(file);
      if (stamp !== null && !withinFileSizeCap(this.scope, stamp.sizeBytes)) {
        out.push({ path: file, sizeBytes: stamp.sizeBytes });
      }
    }
    return out;
  }

  async statFile(p: string): Promise<FileStamp | null> {
    try {
      const stat = await fs.stat(this.resolve(p));
      return stat.isFile() ? { sizeBytes: stat.size, mtimeMs: stat.mtimeMs } : null;
    } catch (err) {
      if ((err as Bun.SystemError).code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * The conflict files parked in this vault. They are not synced, so this is how a
   * host (and `courier-cli status`) reports what a conflict left behind.
   *
   * The walk follows the scope, with the exclusions lifted: a parked copy may predate
   * the folder being excluded, and reporting it is exactly what this exists for.
   *
   * The engine never parks a config-folder copy (a settings conflict is settled by
   * modification time, with no copy at all), and the all-groups-off scope prunes the
   * config folder's subfolders, so a copy there is not a state this host produces.
   */
  async listConflictFiles(): Promise<string[]> {
    const reportScope: SyncScope = { ...this.scope, excludedFolders: [] };
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!isSyncableDir(relPath, reportScope)) continue;
          await walk(path.join(dir, entry.name), relPath);
        } else if (entry.isFile() && isConflictFile(relPath)) {
          out.push(relPath.replace(/\\/g, "/"));
        }
      }
    };
    await walk(this.root, "");
    return sortedCopy(out);
  }

  async readFile(p: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fs.readFile(this.resolve(p)));
    } catch (err) {
      if ((err as Bun.SystemError).code === "ENOENT") return null;
      throw err;
    }
  }

  async writeFile(p: string, bytes: Uint8Array): Promise<void> {
    await this.createFolder(path.dirname(p));
    await fs.writeFile(this.resolve(p), bytes);
  }

  /**
   * Write a large file through a temporary handle and place it with one rename.
   *
   * The temporary file lives under `.courier/tmp`, a hidden folder no walk enters
   * and the scope never syncs. That is what lets a chunked download land without
   * holding the plaintext: each 4 MiB chunk is written and dropped, and the target
   * changes from the old content to the new one in a single step. A crash between
   * chunks leaves a stale temporary file (harmless, and never listed), never a
   * truncated file at the target — which the next pass would read as a local edit
   * and push.
   */
  async beginWrite(p: string): Promise<SyncWriteStream> {
    const tempDir = this.resolve(".courier/tmp");
    await fs.mkdir(tempDir, { recursive: true });
    await this.sweepStaleParts(tempDir);
    const temp = path.join(tempDir, `${crypto.randomUUID()}.part`);
    const target = this.resolve(p);
    const handle: FileHandle = await fs.open(temp, "w");
    let open = true;

    const discard = async (): Promise<void> => {
      if (open) {
        open = false;
        await handle.close().catch(() => {});
      }
      await fs.unlink(temp).catch(() => {});
    };

    return {
      write: async (chunk) => {
        if (!open) throw new Error(`write: ${p} is already closed`);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
          if (bytesWritten === 0) throw new Error(`write: no progress writing ${p}`);
          offset += bytesWritten;
        }
      },
      close: async () => {
        if (!open) return;
        open = false;
        try {
          await handle.close();
          await this.createFolder(path.dirname(p));
          // `fs.rename` replaces an existing target on every supported platform, and
          // is the one operation that makes the new bytes visible.
          await fs.rename(temp, target);
        } catch (err) {
          await fs.unlink(temp).catch(() => {});
          throw err;
        }
      },
      abort: async () => {
        await discard();
      },
    };
  }

  /** Bun's native streaming SHA-256, so a large download is not hashed in JavaScript. */
  createHasher(): SyncHasher {
    const hash = new Bun.CryptoHasher("sha256");
    return {
      update(chunk) {
        hash.update(chunk);
      },
      digestHex() {
        return hash.digest("hex");
      },
    };
  }

  async deleteFile(p: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(p));
    } catch (err) {
      if ((err as Bun.SystemError).code !== "ENOENT") throw err;
    }
  }

  async renameFile(from: string, to: string): Promise<void> {
    await this.createFolder(path.dirname(to));
    await fs.rename(this.resolve(from), this.resolve(to));
  }

  /**
   * Remove partial files a crashed process left in `.courier/tmp`.
   *
   * A crash between chunks leaves a `.part` file that nothing lists and nothing syncs;
   * it is harmless but accumulates. Only files older than a day are touched, so a
   * concurrent writer's live stream is never removed.
   */
  private async sweepStaleParts(dir: string): Promise<void> {
    const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.endsWith(".part")) continue;
      const file = path.join(dir, name);
      try {
        const stat = await fs.stat(file);
        if (stat.mtimeMs < cutoff) await fs.unlink(file);
      } catch {
        // A file another writer already removed, or a transient stat failure: the
        // sweep is opportunistic and must never fail the pull that triggered it.
      }
    }
  }

  /**
   * Create the folder chain for a vault-relative path.
   *
   * Private: it is not part of `SyncAdapter` (the engine never needs it — the folder a
   * file goes in is the adapter's business) and only `writeFile`/`renameFile` above
   * call it.
   */
  private async createFolder(p: string): Promise<void> {
    if (!p || p === ".") return;
    await fs.mkdir(this.resolve(p), { recursive: true });
  }
}

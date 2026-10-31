import type { DataAdapter } from "obsidian";
import type { SyncLeaseStore } from "@courier/engine";

/**
 * The lease store inside an Obsidian vault.
 *
 * It uses the vault adapter rather than the runtime's `fs`, so the same code runs on desktop and
 * mobile. `mkdir` is the atomic primitive; everything under `.courier/` is a dot folder and
 * therefore outside the sync scope, so lock traffic never becomes vault content.
 */
export class AdapterLeaseStore implements SyncLeaseStore {
  constructor(private readonly adapter: DataAdapter) {}

  async ensureDir(path: string): Promise<void> {
    try {
      await this.adapter.mkdir(path);
    } catch {
      // Already there (or a race); the create below is the actual test.
    }
  }

  async tryCreateDir(path: string): Promise<boolean> {
    // `mkdir` is expected to reject an existing folder; the explicit check also covers a
    // platform adapter that resolves instead, which would otherwise let two writers in.
    if (await this.adapter.exists(path)) return false;
    try {
      await this.adapter.mkdir(path);
      return true;
    } catch {
      return false;
    }
  }

  async tryRename(from: string, to: string): Promise<boolean> {
    try {
      await this.adapter.rename(from, to);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(path: string): Promise<string | null> {
    try {
      return await this.adapter.read(path);
    } catch {
      return null;
    }
  }

  async writeFile(path: string, data: string): Promise<void> {
    await this.adapter.write(path, data);
  }

  async removeFile(path: string): Promise<void> {
    try {
      await this.adapter.remove(path);
    } catch {
      // Already gone.
    }
  }

  async removeDir(path: string): Promise<void> {
    try {
      await this.adapter.rmdir(path, true);
    } catch {
      // Already gone.
    }
  }

  async stat(path: string): Promise<{ mtimeMs: number } | null> {
    try {
      const stat = await this.adapter.stat(path);
      return stat ? { mtimeMs: stat.mtime } : null;
    } catch {
      return null;
    }
  }
}

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { waitFor } from "@courier/testing";
import { LeaseStore, watchLeaseRelease } from "./lease";

/** The filesystem half of the lease: every primitive the engine relies on, for real. */
describe("LeaseStore", () => {
  it("creates directories atomically and moves a stale one aside", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "courier-lease-"));
    const store = new LeaseStore(root);

    await store.ensureDir(".courier");
    expect(await store.tryCreateDir(".courier/sync-lease")).toBe(true);
    expect(await store.tryCreateDir(".courier/sync-lease")).toBe(false);

    await store.writeFile(".courier/sync-lease/owner.json", "{}");
    expect(await store.readFile(".courier/sync-lease/owner.json")).toBe("{}");
    expect((await store.stat(".courier/sync-lease"))?.mtimeMs).toBeGreaterThan(0);

    expect(await store.tryRename(".courier/sync-lease", ".courier/sync-lease.old")).toBe(true);
    expect(await store.readFile(".courier/sync-lease.old/owner.json")).toBe("{}");
    await store.removeDir(".courier/sync-lease.old");
    expect(await store.stat(".courier/sync-lease.old")).toBeNull();

    await store.writeFile(".courier/note.txt", "x");
    await store.removeFile(".courier/note.txt");
    expect(await store.readFile(".courier/note.txt")).toBeNull();
  });

  it("keeps every path inside the vault root", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "courier-lease-"));
    const store = new LeaseStore(root);
    await expect(store.readFile("../escape")).rejects.toThrow("escapes vault root");
  });
});

describe("watchLeaseRelease", () => {
  it("wakes on any lease event and stops cleanly", () => {
    let listener: ((event: string, filename: string | null) => void) | null = null;
    const close = vi.fn();
    const watch = vi.fn(
      (
        _path: string,
        _options: { persistent: boolean },
        callback: (event: string, filename: string | null) => void,
      ) => {
        listener = callback;
        return { close, on: vi.fn() };
      },
    ) as unknown as typeof import("fs").watch;
    const onChange = vi.fn();

    const stop = watchLeaseRelease("/vault", onChange, watch);
    listener!("change", "sync-lease/owner.json");
    listener!("rename", "sync-lease");
    listener!("change", null);
    expect(onChange).toHaveBeenCalledTimes(3);

    stop();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("wakes on a real filesystem release", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "courier-watch-"));
    mkdirSync(path.join(root, ".courier", "sync-lease"), { recursive: true });
    writeFileSync(path.join(root, ".courier", "sync-lease", "owner.json"), "{}");
    const onChange = vi.fn();
    const stop = watchLeaseRelease(root, onChange);
    try {
      // Let the platform watcher become ready before the first change.
      await new Promise((resolve) => setTimeout(resolve, 50));
      rmSync(path.join(root, ".courier", "sync-lease"), { recursive: true, force: true });
      await waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2_000 });
    } finally {
      stop();
    }
  });

  it("returns a no-op when the directory cannot be watched", () => {
    const stop = watchLeaseRelease("/vault", () => {}, (() => {
      throw new Error("ENOENT");
    }) as unknown as typeof import("fs").watch);
    expect(() => stop()).not.toThrow();
  });
});

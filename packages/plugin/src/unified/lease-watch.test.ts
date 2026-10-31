import type { DataAdapter } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubGlobal, restoreGlobals } from "@courier/testing";
import { watchLeaseDirectory } from "./lease-watch";

/**
 * The desktop wake-up is the difference between a handoff in milliseconds and one bounded
 * by the fallback timer. Obsidian has no adapter watcher, so this is the one place the
 * plugin reaches for a desktop-only module; the no-op paths are what keep mobile and the test runtime safe.
 */
describe("watchLeaseDirectory", () => {
  afterEach(() => {
    restoreGlobals();
  });

  it("is a no-op without a desktop window or a filesystem adapter", () => {
    expect(watchLeaseDirectory({} as DataAdapter, () => {})).toStrictEqual(expect.any(Function));

    stubGlobal("window", { require: undefined });
    expect(watchLeaseDirectory({} as DataAdapter, () => {})).toStrictEqual(expect.any(Function));
  });

  it("watches .courier, wakes on a release, and ignores owner renewals", () => {
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
    );
    const require = vi.fn((id: string) =>
      id === "fs" ? { watch } : { join: (...parts: string[]) => parts.join("/") },
    );
    stubGlobal("window", { require });
    const onChange = vi.fn();
    const adapter = { getBasePath: () => "/vault" } as unknown as DataAdapter;

    const stop = watchLeaseDirectory(adapter, onChange);

    expect(watch).toHaveBeenCalledWith(
      "/vault/.courier",
      { persistent: false },
      expect.any(Function),
    );
    listener!("rename", "sync-lease");
    listener!("change", "sync-lease/owner.json");
    listener!("change", null);
    expect(onChange).toHaveBeenCalledTimes(3);

    stop();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

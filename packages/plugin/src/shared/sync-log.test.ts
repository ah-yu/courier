import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncActivityEvent, SyncActivityEventBase } from "@courier/engine";
import {
  SYNC_LOG_LIMIT,
  clearSyncLog,
  getSyncLog,
  onSyncLogChange,
  recordSyncActivity,
  resetSyncLogForTests,
} from "./sync-log";

beforeEach(() => resetSyncLogForTests());
afterEach(() => resetSyncLogForTests());

function applied(
  direction: "in" | "out",
  overrides: Partial<SyncActivityEventBase> = {},
): SyncActivityEvent {
  return {
    direction,
    outcome: "applied",
    fileId: "file-1",
    versionId: "version-1",
    plainPath: "note.md",
    action: "create",
    sizeBytes: 3,
    deviceName: null,
    ...overrides,
  };
}

function skipped(
  direction: "in" | "out",
  reason: "folder" | "size",
  overrides: Partial<SyncActivityEventBase> = {},
): SyncActivityEvent {
  return {
    direction,
    outcome: "skipped",
    fileId: null,
    versionId: null,
    plainPath: "private/note.md",
    action: null,
    sizeBytes: 10,
    deviceName: null,
    reason,
    ...overrides,
  };
}

describe("the session sync log", () => {
  it("keeps events newest first, stamped with the moment this device saw them", () => {
    recordSyncActivity(applied("out", { versionId: "v1", plainPath: "a.md" }));
    recordSyncActivity(applied("in", { versionId: "v2", plainPath: "b.md" }));

    const { entries, total } = getSyncLog();
    expect(total).toBe(2);
    expect(entries.map((entry) => entry.plainPath)).toEqual(["b.md", "a.md"]);
    for (const entry of entries) expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
  });

  it("ignores the same version reported twice, but records a different one", () => {
    // A skipped chain is seen again by every pass; the reconcile re-reports it.
    recordSyncActivity(skipped("in", "folder", { versionId: "v1" }));
    recordSyncActivity(skipped("in", "folder", { versionId: "v1" }));
    expect(getSyncLog().total).toBe(1);

    recordSyncActivity(skipped("in", "folder", { versionId: "v2" }));
    expect(getSyncLog().total).toBe(2);
    expect(getSyncLog().entries.map((entry) => entry.versionId)).toEqual(["v2", "v1"]);
  });

  it("de-duplicates a versionless skip by path, reason and size", () => {
    recordSyncActivity(skipped("out", "size", { plainPath: "big.mov", sizeBytes: 100 }));
    recordSyncActivity(skipped("out", "size", { plainPath: "big.mov", sizeBytes: 100 }));
    expect(getSyncLog().total).toBe(1);

    // The file grew: that is a new attempt, and a new row.
    recordSyncActivity(skipped("out", "size", { plainPath: "big.mov", sizeBytes: 200 }));
    expect(getSyncLog().total).toBe(2);
  });

  it("keeps the recent end at the cap and still counts everything", () => {
    for (let index = 0; index < SYNC_LOG_LIMIT + 5; index += 1) {
      recordSyncActivity(
        applied("out", {
          fileId: `file-${index}`,
          versionId: `version-${index}`,
          plainPath: `${index}.md`,
        }),
      );
    }

    const { entries, total } = getSyncLog();
    expect(total).toBe(SYNC_LOG_LIMIT + 5);
    expect(entries).toHaveLength(SYNC_LOG_LIMIT);
    // The newest survive: the last recorded is first, the first is evicted.
    expect(entries[0]!.plainPath).toBe(`${SYNC_LOG_LIMIT + 4}.md`);
    expect(entries.at(-1)!.plainPath).toBe("5.md");
  });

  it("notifies listeners, and stops after unsubscribe", () => {
    const seen = vi.fn();
    const stop = onSyncLogChange(seen);
    recordSyncActivity(applied("out"));
    expect(seen).toHaveBeenCalledTimes(1);

    stop();
    recordSyncActivity(applied("out", { versionId: "v2" }));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("does not let a failing listener stop the others or the record", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const healthy = vi.fn();
    onSyncLogChange(() => {
      throw new Error("listener blew up");
    });
    onSyncLogChange(healthy);

    expect(() => recordSyncActivity(applied("out"))).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(getSyncLog().total).toBe(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("sync-log listener failed");
    error.mockRestore();
  });

  it("clears the run's events and tells an open dialog", () => {
    const seen = vi.fn();
    const stop = onSyncLogChange(seen);
    recordSyncActivity(applied("out"));
    clearSyncLog();

    expect(getSyncLog()).toEqual({ entries: [], total: 0 });
    expect(seen).toHaveBeenCalledTimes(2);
    // The same version may be recorded again in a new run.
    recordSyncActivity(applied("out"));
    expect(getSyncLog().total).toBe(1);
    stop();
  });
});

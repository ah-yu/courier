import { beforeEach, describe, expect, it } from "vitest";
import { SYNC_ACTIONS, type FileVersionInfo } from "@courier/shared";
import { setLocale } from "../i18n";
import { formatVersionSize, groupVersionsByDay, versionActionIcon } from "./version-history";

beforeEach(() => setLocale("zh"));

/**
 * The version list's presentation layer.
 *
 * The rows themselves come from the server's chain (`getFileVersionHistory`); what is pinned
 * here is what the view does with them — the day boundaries, the marker each action draws,
 * and the size a row prints. The **order** is not computed here: the view reverses the
 * server's oldest-first chain once, and the L2 suite asserts the rendered order.
 */
function version(overrides: Partial<FileVersionInfo> = {}): FileVersionInfo {
  return {
    versionId: "version-1",
    contentHash: "hash-1",
    encryptedPath: "enc-path",
    action: "modify",
    sizeBytes: 5,
    mtimeMs: 0,
    deviceName: "Laptop",
    createdAt: "2026-10-27T13:58:00.000Z",
    ...overrides,
  } as FileVersionInfo;
}

/** A local timestamp, so the day boundaries are the test's own timezone. */
function local(year: number, month: number, day: number, hour = 12): string {
  return new Date(year, month - 1, day, hour).toISOString();
}

describe("groupVersionsByDay", () => {
  it("keeps the order it is given, day by day", () => {
    const versions = [
      version({ createdAt: local(2026, 10, 27, 15), versionId: "newest" }),
      version({ createdAt: local(2026, 10, 27, 9), versionId: "same-day" }),
      version({ createdAt: local(2026, 10, 26, 18), versionId: "older-day" }),
    ];

    const days = groupVersionsByDay(versions);

    expect(days.map((day) => day.versions.map((item) => item.versionId))).toEqual([
      ["newest", "same-day"],
      ["older-day"],
    ]);
  });

  it("starts a new day at local midnight, not at UTC midnight", () => {
    // 23:30 and 00:30 local on consecutive days; a UTC-based grouping would join or split
    // them differently depending on the machine's offset.
    const late = new Date(2026, 9, 27, 23, 30);
    const early = new Date(2026, 9, 28, 0, 30);

    const days = groupVersionsByDay([
      version({ createdAt: early.toISOString(), versionId: "after-midnight" }),
      version({ createdAt: late.toISOString(), versionId: "before-midnight" }),
    ]);

    expect(days).toHaveLength(2);
    expect(days[0]!.versions[0]!.versionId).toBe("after-midnight");
  });

  it("does not re-sort a chain that arrives out of order", () => {
    // The view's order is "the server's chain, reversed"; grouping only joins neighbours, so
    // a chain that somehow arrived oldest first is rendered as it arrived rather than being
    // silently re-ordered into a different history.
    const days = groupVersionsByDay([
      version({ createdAt: local(2026, 10, 26, 9), versionId: "first" }),
      version({ createdAt: local(2026, 10, 27, 9), versionId: "second" }),
    ]);

    expect(days.map((day) => day.versions[0]!.versionId)).toEqual(["first", "second"]);
  });
});

describe("versionActionIcon", () => {
  it("draws a marker for every action the wire can carry", () => {
    for (const action of SYNC_ACTIONS) {
      expect(versionActionIcon(action), action).toMatch(/^\S+$/);
    }
  });
});

describe("formatVersionSize", () => {
  it("reads bytes, kilobytes and megabytes in the unit a person uses", () => {
    expect(formatVersionSize(5)).toBe("5 B");
    expect(formatVersionSize(1023)).toBe("1023 B");
    expect(formatVersionSize(2048)).toBe("2 KB");
    expect(formatVersionSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });

  it("says an empty version has no content", () => {
    expect(formatVersionSize(0)).toBe("无内容");
  });
});

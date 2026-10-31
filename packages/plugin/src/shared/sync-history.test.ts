import { beforeEach, describe, expect, it } from "vitest";
import { messagesFor, setLocale, t } from "../i18n";
import { SYNC_LOG_LIMIT, type SyncLogEntry } from "./sync-log";
import {
  deviceLabel,
  directionTooltip,
  entryDeviceLabel,
  formatClockTime,
  formatCount,
  formatHistoryDay,
  formatHistoryTime,
  groupSyncHistoryByDay,
  skipLine,
  skipReasonLabel,
  syncActionLabel,
  syncHistorySummary,
} from "./sync-history";

beforeEach(() => setLocale("zh"));

/**
 * The session log's presentation layer.
 *
 * The rows themselves are the log store's (`sync-log.test.ts`); what is pinned here is
 * what the dialog does with them — day boundaries, clock and count formatting, the way a
 * row names a device and the words a skipped row uses. All of it is locale-dependent and
 * reads the catalog at call time.
 */
function entry(overrides: Partial<SyncLogEntry> = {}): SyncLogEntry {
  return {
    at: "2026-06-01T10:00:00.000Z",
    direction: "in",
    outcome: "applied",
    fileId: "file-1",
    versionId: "version-1",
    plainPath: "note.md",
    action: "modify",
    sizeBytes: 3,
    deviceName: "MacBook",
    ...overrides,
  } as SyncLogEntry;
}

/** A local timestamp, so the day boundaries are the test's own timezone. */
function local(year: number, month: number, day: number, hour = 12, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

describe("groupSyncHistoryByDay", () => {
  it("keeps the newest day first and the newest event first inside it", () => {
    const entries = [
      entry({ at: local(2026, 10, 18, 15), versionId: "mid" }),
      entry({ at: local(2026, 10, 18, 9), versionId: "new" }),
      entry({ at: local(2026, 10, 16, 9), versionId: "old" }),
    ];

    const days = groupSyncHistoryByDay(entries);

    expect(days.map((day) => day.entries.map((item) => item.versionId))).toEqual([
      ["mid", "new"],
      ["old"],
    ]);
    // The day's header is formatted from its own newest event.
    expect(days[0]!.at).toBe(local(2026, 10, 18, 15));
  });

  it("splits on the local calendar day, not on 24-hour buckets", () => {
    const entries = [
      entry({ at: local(2026, 10, 19, 0, 5), versionId: "after-midnight" }),
      entry({ at: local(2026, 10, 18, 23, 55), versionId: "late" }),
    ];

    // Ten minutes apart, but two days — a header that said "today" for both would be
    // lying about the second one.
    expect(groupSyncHistoryByDay(entries).map((day) => day.entries.length)).toEqual([1, 1]);
  });

  it("is empty for an empty stream", () => {
    expect(groupSyncHistoryByDay([])).toEqual([]);
  });

  it("keeps distinct unparseable timestamps in their own groups", () => {
    // A malformed timestamp cannot be turned into a calendar day; the function falls back
    // to the raw string, so two different bad values are not silently merged into one
    // "NaN" day.
    const entries = [entry({ at: "not a date" }), entry({ at: "also not a date" })];
    expect(groupSyncHistoryByDay(entries)).toHaveLength(2);
  });
});

const localAt = (day: number, hour: number): string => new Date(2026, 9, day, hour).toISOString();

describe("the log's wording", () => {
  it("keeps the action labels the version history and the e2e suite rely on", () => {
    expect({
      create: syncActionLabel("create"),
      modify: syncActionLabel("modify"),
      rename: syncActionLabel("rename"),
      delete: syncActionLabel("delete"),
      restore: syncActionLabel("restore"),
    }).toEqual({
      create: "创建",
      modify: "修改",
      rename: "重命名",
      delete: "删除",
      restore: "恢复",
    });
  });

  it("names a version with no label instead of showing an empty gap", () => {
    expect(deviceLabel("MacBook")).toBe("MacBook");
    expect(deviceLabel(null)).toBe("未知设备");
    expect(deviceLabel(undefined)).toBe("未知设备");
    expect(deviceLabel("   ")).toBe("未知设备");
  });

  it("names an incoming row whose pusher is unknown as another device", () => {
    // A chain discovered by a reconcile carries no label; the direction is still known.
    expect(entryDeviceLabel(entry({ direction: "in", deviceName: null }))).toBe("其他设备");
    expect(entryDeviceLabel(entry({ direction: "in", deviceName: "  Mobile " }))).toBe("Mobile");
    // An outgoing row always states this device; a missing label degrades to the old word.
    expect(entryDeviceLabel(entry({ direction: "out", deviceName: null }))).toBe("未知设备");

    setLocale("en");
    expect(entryDeviceLabel(entry({ direction: "in", deviceName: null }))).toBe("Another device");
  });

  it("renders a usable local time in the plugin's language, and falls back to the raw value", () => {
    expect(formatHistoryTime("2026-06-01T10:00:00.000Z")).toBe(
      new Date("2026-06-01T10:00:00.000Z").toLocaleString("zh-CN"),
    );
    expect(formatHistoryTime("not a date")).toBe("not a date");

    setLocale("en");
    expect(formatHistoryTime("2026-06-01T10:00:00.000Z")).toBe(
      new Date("2026-06-01T10:00:00.000Z").toLocaleString("en-US"),
    );
  });

  it("stamps a row with a fixed, locale-independent clock reading", () => {
    // Local time, zero-padded, seconds included — the day is the group header's job.
    const at = new Date(2026, 9, 15, 20, 33, 13);
    expect(formatClockTime(at.toISOString())).toBe("20:33:13");
    const single = new Date(2026, 0, 2, 3, 4, 5);
    expect(formatClockTime(single.toISOString())).toBe("03:04:05");
    expect(formatClockTime("not a date")).toBe("not a date");
  });

  it("names the day of a group as 今天 / 昨天 / a date", () => {
    const now = new Date(2026, 9, 18, 16, 0).getTime();

    expect(formatHistoryDay(localAt(18, 9), now)).toBe("今天");
    expect(formatHistoryDay(localAt(17, 23), now)).toBe("昨天");
    // Older than that is the date itself: "3 天前" would be arithmetic for the reader,
    // and the row's clock reading is right underneath it anyway.
    expect(formatHistoryDay(localAt(15, 9), now)).toBe(
      new Date(2026, 9, 15).toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
    );
    expect(formatHistoryDay("not a date", now)).toBe("not a date");

    setLocale("en");
    expect(formatHistoryDay(localAt(18, 9), now)).toBe("Today");
    expect(formatHistoryDay(localAt(17, 9), now)).toBe("Yesterday");
    // The English date shape too: the locale branch is not only the two relative words.
    expect(formatHistoryDay(localAt(15, 9), now)).toBe(
      new Date(2026, 9, 15).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
    );
  });

  it("groups a count for the reader's language", () => {
    expect(formatCount(7)).toBe("7");
    expect(formatCount(1024)).toBe((1024).toLocaleString("zh-CN"));
    setLocale("en");
    expect(formatCount(1024)).toBe("1,024");
  });

  it("renders the header's count with a real number, and says the log is this run's", () => {
    // The dialog shipped showing the literal `共 {total} 次同步事件。` because the summary
    // template was translated without its `{total}` parameter. The summary is a value
    // now, and this pins the number into it.
    const summary = syncHistorySummary(128, 128);
    expect(summary.count).toBe(128);
    expect(summary.label).toBe("条同步记录");
    expect(summary.note).toBe("本次运行");

    // Truncated: the total is still the run's, and the note says how much is shown.
    const truncated = syncHistorySummary(SYNC_LOG_LIMIT + 50, SYNC_LOG_LIMIT);
    expect(truncated.count).toBe(SYNC_LOG_LIMIT + 50);
    expect(truncated.note).toBe(`本次运行 · 只显示最近 ${SYNC_LOG_LIMIT} 条`);

    setLocale("en");
    expect(syncHistorySummary(1, 1).label).toBe("sync event");
    expect(syncHistorySummary(2, 2).label).toBe("sync events");
    expect(syncHistorySummary(2, 2).note).toBe("This run");
    expect(syncHistorySummary(2, 1).note).toBe("This run · showing the latest 1");
  });

  it("names the switch a skipped row records, and words it in the past tense", () => {
    // The five reasons have to stay distinct — a user sent to the wrong page is worse off
    // than one told nothing — and the line says the decision was made then ("was off").
    const labels = new Set([
      skipReasonLabel("folder"),
      skipReasonLabel("fileType"),
      skipReasonLabel("settingsGroup"),
      skipReasonLabel("size"),
      skipReasonLabel("pathTooLong"),
    ]);
    expect(labels.size).toBe(5);
    for (const label of labels) {
      expect(label).not.toBe("");
      expect(label).not.toContain("{");
    }

    expect(skipLine({ direction: "in", reason: "settingsGroup" })).toBe(
      "本设备未应用：这组 Obsidian 设置未开启",
    );
    expect(skipLine({ direction: "out", reason: "size" })).toBe("未发送：超过这个账号的大小上限");

    setLocale("en");
    expect(skipReasonLabel("folder")).toContain("folder");
    expect(skipReasonLabel("fileType")).toContain("file type");
    expect(skipReasonLabel("settingsGroup")).toContain("settings group");
    expect(skipReasonLabel("size")).toContain("size limit");
    expect(skipReasonLabel("pathTooLong")).toContain("path");
    expect(skipLine({ direction: "in", reason: "folder" })).toBe(
      "Not applied here: The folder is excluded",
    );
  });

  it("describes the arrow by direction only", () => {
    // Direction, not outcome: a skipped row says "Not sent" underneath, so the tooltip
    // must not claim it was sent.
    expect(directionTooltip("out")).toBe("来自这台设备");
    expect(directionTooltip("in")).toBe("来自其他设备");
    setLocale("en");
    expect(directionTooltip("out")).toBe("From this device");
    expect(directionTooltip("in")).toBe("From another device");
  });

  it("renders every template the dialog uses with no placeholder left behind", () => {
    // A template whose placeholder is never passed renders literally — that is exactly
    // how the header shipped showing `共 {total} 次同步事件。`, and every assertion that
    // only looked for the surrounding words still passed. Each template is rendered here
    // with the parameters its call site passes, so a key that forgets one fails.
    const params = {
      shown: 3,
      id: "abcd1234",
      time: "09:41:07",
      device: "Laptop",
      reason: "reason",
    };
    for (const locale of ["zh", "en"] as const) {
      setLocale(locale);
      for (const key of Object.keys(messagesFor(locale))) {
        if (!key.startsWith("dialog.syncHistory.")) continue;
        expect(t(key as Parameters<typeof t>[0], params), `${locale} ${key}`).not.toContain("{");
      }
    }
  });
});

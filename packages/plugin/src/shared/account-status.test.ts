import { describe, expect, it } from "vitest";
import { setLocale } from "../i18n";
import { formatBytes, keyExpiryDate, keyExpiryText, storageMenuValue } from "./account-status";

const NOW = Date.parse("2026-10-20T12:00:00Z");

describe("keyExpiryText", () => {
  it("distinguishes never, malformed and expired keys", () => {
    setLocale("zh");
    expect(keyExpiryText(null, NOW)).toBe("永不过期");
    expect(keyExpiryText("not a date", NOW)).toBe("未知");
    expect(keyExpiryText("2026-10-20T11:59:59Z", NOW)).toBe("已过期");
  });

  it("rounds a remaining fraction of a day up, so a valid key never reads zero", () => {
    setLocale("zh");
    expect(keyExpiryText("2026-10-20T12:00:00.001Z", NOW)).toBe("剩余 1 天");
    expect(keyExpiryText("2026-10-21T12:00:00Z", NOW)).toBe("剩余 1 天");
    expect(keyExpiryText("2026-10-21T12:00:00.001Z", NOW)).toBe("剩余 2 天");
    expect(keyExpiryText("2026-10-23T12:00:00Z", NOW)).toBe("剩余 3 天");
  });

  it("uses English plural forms", () => {
    setLocale("en");
    expect(keyExpiryText("2026-10-20T23:00:00Z", NOW)).toBe("1 day left");
    expect(keyExpiryText("2026-10-22T12:00:00Z", NOW)).toBe("2 days left");
    expect(keyExpiryText(null, NOW)).toBe("Never expires");
  });
});

describe("keyExpiryDate", () => {
  it("renders the local calendar date, not the UTC slice", () => {
    const localNoon = new Date(2027, 0, 1, 12, 0, 0).toISOString();
    expect(keyExpiryDate(localNoon)).toBe("2027-01-01");
    expect(keyExpiryDate(null)).toBeNull();
    expect(keyExpiryDate("not a date")).toBeNull();
  });
});

describe("formatBytes", () => {
  it("keeps small values in bytes and switches to binary units above 1024", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5.0 GB");
  });

  it("does not print nonsense for an invalid count", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("storageMenuValue", () => {
  it("reports used over the limit and the bar's filled share", () => {
    setLocale("zh");
    const megabyte = 1024 * 1024;
    expect(storageMenuValue(megabyte, 5 * megabyte)).toEqual({
      text: "1.0 MB/5.0 MB",
      percent: 20,
    });
    expect(storageMenuValue(0, 5 * megabyte)).toEqual({ text: "0 B/5.0 MB", percent: 0 });
    // A limit can be overshot by the server's 30-second usage window; the bar clamps
    // instead of overflowing its track.
    expect(storageMenuValue(6 * megabyte, 5 * megabyte)).toEqual({
      text: "6.0 MB/5.0 MB",
      percent: 100,
    });
    expect(storageMenuValue(megabyte, megabyte)).toEqual({
      text: "1.0 MB/1.0 MB",
      percent: 100,
    });
    // A zero quota is fully consumed by definition.
    expect(storageMenuValue(megabyte, 0)).toEqual({ text: "1.0 MB/0 B", percent: 100 });
  });

  it("draws no bar for an unlimited account or a failed read", () => {
    setLocale("zh");
    expect(storageMenuValue(1024 * 1024, null)).toEqual({
      text: "1.0 MB / 无上限",
      percent: null,
    });
    expect(storageMenuValue(undefined, 1024)).toEqual({ text: "读取失败", percent: null });
    expect(storageMenuValue(Number.NaN, null)).toEqual({ text: "读取失败", percent: null });
  });

  it("renders English copy", () => {
    setLocale("en");
    expect(storageMenuValue(1024, null)).toEqual({
      text: "1.0 KB / unlimited",
      percent: null,
    });
    expect(storageMenuValue(1024, 2048)).toEqual({ text: "1.0 KB/2.0 KB", percent: 50 });
  });
});

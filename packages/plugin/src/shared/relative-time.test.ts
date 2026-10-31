import { beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "../i18n";
import { createdAgoLabel, formatRelativeTime } from "./relative-time";

beforeEach(() => setLocale("zh"));

/**
 * The vault picker shows how old each remote vault is, and the buckets are the whole
 * contract: a person reads "7 个月前", not a timestamp. Pinned here so the wording
 * (and the fallback for a date the server did not send) cannot drift silently.
 */

const NOW = Date.parse("2026-10-15T12:00:00.000Z");

/** An ISO timestamp `seconds` before the fixed "now" the cases read against. */
function ago(seconds: number): string {
  return new Date(NOW - seconds * 1000).toISOString();
}

describe("formatRelativeTime", () => {
  it("reads as a person would say it", () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe("刚刚");
    expect(formatRelativeTime(ago(59), NOW)).toBe("刚刚");
    expect(formatRelativeTime(ago(60), NOW)).toBe("1 分钟前");
    expect(formatRelativeTime(ago(45 * 60), NOW)).toBe("45 分钟前");
    expect(formatRelativeTime(ago(3 * 3600), NOW)).toBe("3 小时前");
    expect(formatRelativeTime(ago(2 * 86400), NOW)).toBe("2 天前");
    expect(formatRelativeTime(ago(29 * 86400), NOW)).toBe("29 天前");
    expect(formatRelativeTime(ago(30 * 86400), NOW)).toBe("1 个月前");
    expect(formatRelativeTime(ago(7 * 30 * 86400), NOW)).toBe("7 个月前");
    expect(formatRelativeTime(ago(11 * 30 * 86400), NOW)).toBe("11 个月前");
    expect(formatRelativeTime(ago(365 * 86400), NOW)).toBe("1 年前");
    expect(formatRelativeTime(ago(3 * 365 * 86400), NOW)).toBe("3 年前");
  });

  it("never counts backwards when a clock is ahead of the server", () => {
    expect(formatRelativeTime(new Date(NOW + 60_000).toISOString(), NOW)).toBe("刚刚");
  });

  it("answers nothing for a timestamp it cannot read", () => {
    expect(formatRelativeTime("", NOW)).toBe("");
    expect(formatRelativeTime("not a date", NOW)).toBe("");
  });

  it("labels the row's description, and stays silent without a date", () => {
    expect(createdAgoLabel(ago(7 * 30 * 86400), NOW)).toBe("创建于 7 个月前");
    expect(createdAgoLabel("not a date", NOW)).toBe("");
  });

  it("uses English singular and plural forms when the plugin runs in English", () => {
    setLocale("en");
    expect(formatRelativeTime(ago(0), NOW)).toBe("just now");
    expect(formatRelativeTime(ago(60), NOW)).toBe("1 minute ago");
    expect(formatRelativeTime(ago(45 * 60), NOW)).toBe("45 minutes ago");
    expect(formatRelativeTime(ago(3 * 3600), NOW)).toBe("3 hours ago");
    expect(formatRelativeTime(ago(2 * 86400), NOW)).toBe("2 days ago");
    expect(formatRelativeTime(ago(30 * 86400), NOW)).toBe("1 month ago");
    expect(formatRelativeTime(ago(3 * 365 * 86400), NOW)).toBe("3 years ago");
    expect(createdAgoLabel(ago(7 * 30 * 86400), NOW)).toBe("Created 7 months ago");
  });
});

import { plural, t } from "../i18n";

/** One day in milliseconds, for the key-expiry countdown. */
const DAY_MS = 86_400_000;

/**
 * How long a surface waits for `GET /api/me` before falling back to what it knows.
 *
 * Both readers of the account — the status menu and the settings page — bound the read
 * with this: an unreachable server must not leave a click with no menu, or a settings
 * row stuck on "Reading account…", for as long as the request takes to fail.
 */
export const ACCOUNT_READ_TIMEOUT_MS = 1_500;

/**
 * How much of the key's validity is left, as one short value.
 *
 * The count is rounded **up**: a key with twelve hours left still has a day of validity,
 * and "0 days left" for a key that works would read as a bug. A missing expiry is the
 * server's "never expires", which is a different answer from a missing or malformed date.
 */
export function keyExpiryText(expiresAt: string | null, now = Date.now()): string {
  if (expiresAt === null) return t("status.value.expiry.never");
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return t("status.value.expiry.unknown");
  const remaining = expires - now;
  if (remaining <= 0) return t("status.value.expiry.expired");
  const days = Math.ceil(remaining / DAY_MS);
  return plural("status.value.expiry.days.one", "status.value.expiry.days.other", days);
}

/**
 * The expiry's calendar date in the device's own timezone, or null.
 *
 * The settings page adds this to the countdown so a mobile user can see *when* the key
 * ends, not only how many days are left. The date is local on purpose: the expiry is an
 * instant, and a user reading "2027-01-01" means their own new year, not UTC's.
 */
export function keyExpiryDate(expiresAt: string | null): string | null {
  if (expiresAt === null) return null;
  const date = new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) return null;
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** A storage row's text and, when the account has a finite quota, its filled share. */
export interface StorageMenuValue {
  /** `used/limit`, `used / unlimited`, or the one-line read failure. */
  text: string;
  /** 0–100 for a finite quota; null when there is nothing to draw a bar against. */
  percent: number | null;
}

/**
 * Storage used against the account's limit, ready for the menu's progress row.
 *
 * `usedBytes` is optional in `GET /api/me` (an older/limited response may omit it), and a
 * null limit is the server's "unlimited": the two must not both collapse to "—". A finite
 * limit gets a percentage so the menu can draw the bar the text alone cannot; a used
 * amount above the limit clamps the bar rather than overflowing it.
 */
export function storageMenuValue(
  usedBytes: number | undefined,
  storageBytesLimit: number | null,
): StorageMenuValue {
  if (usedBytes === undefined || !Number.isFinite(usedBytes) || usedBytes < 0) {
    return { text: t("status.value.storage.unknown"), percent: null };
  }
  const used = formatBytes(usedBytes);
  if (storageBytesLimit === null) {
    return { text: t("status.value.storage.unlimited", { used }), percent: null };
  }
  if (!Number.isFinite(storageBytesLimit) || storageBytesLimit < 0) {
    return { text: t("status.value.storage.unknown"), percent: null };
  }
  return {
    text: t("status.value.storage.ratio", {
      used,
      limit: formatBytes(storageBytesLimit),
    }),
    percent:
      storageBytesLimit === 0
        ? 100
        : Math.min(100, Math.max(0, (usedBytes / storageBytesLimit) * 100)),
  };
}

/**
 * A byte count in the unit a person reads (KB/MB/GB/TB), one decimal from KB upward.
 *
 * Binary units, matching the plugin's existing size copy: "1 GB" is 1024 MB. Values below
 * a kilobyte stay whole bytes so a 3-byte note does not read as "0.0 KB".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  return `${value.toFixed(1)} ${units[unit]}`;
}

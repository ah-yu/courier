import { plural, t } from "../i18n";

/**
 * How long ago something happened, in the plugin's current UI language.
 *
 * A remote vault's age is the only thing that tells two same-named vaults apart in
 * the picker (a user who has "notes" on two servers, or who recreated a vault after
 * deleting it), so the list shows it the way a person says it — "7 个月前" /
 * "7 months ago" — rather than as a timestamp they would have to compare by hand.
 *
 * Deliberately not `moment`: this is one line of arithmetic, the buckets are ours
 * (30-day months, 365-day years), and the e2e runtime stub would otherwise have to
 * model a date library to render the dialog at all.
 */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";

  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return t("history.relative.justNow");

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return plural("history.relative.minutes.one", "history.relative.minutes.other", minutes);
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return plural("history.relative.hours.one", "history.relative.hours.other", hours);
  }

  const days = Math.round(hours / 24);
  if (days < 30) {
    return plural("history.relative.days.one", "history.relative.days.other", days);
  }

  const months = Math.round(days / 30);
  if (months < 12) {
    return plural("history.relative.months.one", "history.relative.months.other", months);
  }

  const years = Math.round(months / 12);
  return plural("history.relative.years.one", "history.relative.years.other", years);
}

/** The picker's one-line description of a vault's age (`""` when it cannot be read). */
export function createdAgoLabel(iso: string, now = Date.now()): string {
  const relative = formatRelativeTime(iso, now);
  return relative ? t("history.createdAgo", { relative }) : "";
}

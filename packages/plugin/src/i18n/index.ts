import { en } from "./en";
import { isChineseLocale, resolveObsidianLocale, type Locale } from "./locale";
import { zh, type PluginMessageKey } from "./zh";

export type { Locale, PluginMessageKey };
export { isChineseLocale, resolveObsidianLocale };

/** Placeholder values accepted by {@link t}. */
export type MessageParams = Record<string, string | number>;

/**
 * The active catalog's locale.
 *
 * Starts as English so an uninitialised module never silently renders Chinese;
 * the plugin sets this from Obsidian's language at the very start of
 * `onload()`, before any UI can exist.
 */
let activeLocale: Locale = "en";

/** The two complete catalogs. */
const catalogs: Record<Locale, Record<PluginMessageKey, string>> = { zh, en };

/** Set the locale used by {@link t} and {@link plural}. */
export function setLocale(locale: Locale): void {
  activeLocale = locale;
}

/** The locale currently used by the plugin UI. */
export function getLocale(): Locale {
  return activeLocale;
}

/** The complete catalog for a locale (used by tests and language-aware harnesses). */
export function messagesFor(locale: Locale): Record<PluginMessageKey, string> {
  return catalogs[locale];
}

/**
 * Translate a key, replacing `{name}` placeholders from `params`.
 *
 * Replacement is a single pass, so a path inserted into the template is never
 * re-scanned for placeholders. A missing parameter leaves its placeholder in
 * place: a visible `{name}` is easier to catch in a test than a silently empty
 * string, and `t` is never used to render untrusted templates.
 */
export function t(key: PluginMessageKey, params?: MessageParams): string {
  const template = catalogs[activeLocale][key] ?? zh[key];
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/**
 * Pick the singular or plural form of a key and render it.
 *
 * English is the only catalog with distinct forms; Chinese repeats the same
 * text under `.one` and `.other` so call sites stay identical. `count` is
 * always supplied as `{count}`.
 */
export function plural(
  oneKey: PluginMessageKey,
  otherKey: PluginMessageKey,
  count: number,
  params: MessageParams = {},
): string {
  return t(count === 1 ? oneKey : otherKey, { ...params, count });
}

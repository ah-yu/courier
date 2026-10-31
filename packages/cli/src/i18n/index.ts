import { en } from "./en";
import { zh, type MessageKey } from "./zh";

/** The languages the CLI ships with. */
export type Locale = "zh" | "en";

export { en, zh };
export type { MessageKey };

/**
 * The active catalog.
 *
 * The module default is English so the code is deterministic when imported by a
 * test or another tool. `main.ts` always calls {@link setLocale} before building
 * the commander program, and the real default is decided there from the OS
 * language (see `i18n/locale.ts`).
 */
let activeLocale: Locale = "en";

/** Switch the catalog used by {@link t} and {@link plural}. */
export function setLocale(locale: Locale): void {
  activeLocale = locale;
}

/** The catalog currently in use. */
export function getLocale(): Locale {
  return activeLocale;
}

const catalogs: Record<Locale, Record<MessageKey, string>> = { en, zh };

/**
 * Render one message, replacing `{name}` placeholders from `params`.
 *
 * A single `replace` pass with a function replacer is deliberate: inserted values
 * are never scanned for placeholders, and a path containing `$&` is not treated as
 * a replacement pattern. An unknown placeholder is left visible, which a test can
 * catch and a developer sees immediately instead of reading an empty string.
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = catalogs[activeLocale][key];
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
}

/**
 * Pick the singular or plural message for `count` and render it.
 *
 * Only English needs a difference; Chinese declares the same text for both keys.
 * `count` is always supplied to the template, so a caller does not have to repeat
 * a parameter it already had to pass to choose the key.
 */
export function plural(
  oneKey: MessageKey,
  otherKey: MessageKey,
  count: number,
  params: Record<string, string | number> = {},
): string {
  return t(count === 1 ? oneKey : otherKey, { ...params, count });
}

/**
 * Locale resolution for the Obsidian plugin.
 *
 * Obsidian's public `getLanguage()` is the UI language: it follows the OS by
 * default and follows the user's own choice when they set one. The requirement
 * is binary — any Chinese locale answers Chinese, everything else English — so
 * only the primary language subtag matters (`zh-CN`, `zh_TW` and `zh-Hans` are
 * all Chinese; `zh` is not a promise of Simplified vs Traditional).
 */
export type Locale = "zh" | "en";

/** Whether a BCP 47-ish language tag names Chinese. */
export function isChineseLocale(tag: string | null | undefined): boolean {
  if (typeof tag !== "string") return false;
  return /^zh(?:[-_]|$)/i.test(tag.trim());
}

/**
 * Resolve Obsidian's language (or the `navigator.language` fallback) to one of
 * the two catalogs. Empty/unknown input is English, matching the plugin rule
 * that only Chinese gets the Chinese catalog.
 */
export function resolveObsidianLocale(tag: string | null | undefined): Locale {
  return isChineseLocale(tag) ? "zh" : "en";
}

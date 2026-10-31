import type { Locale } from "./index";

/** The locale-related environment variables, in precedence order. */
export interface LocaleEnvironment {
  LC_ALL?: string;
  LC_MESSAGES?: string;
  LANG?: string;
}

/** Why an explicit language choice was refused. */
export type CliLocaleError =
  | { kind: "missing"; value: string }
  | { kind: "invalid"; value: string };

/** The language resolved for this process, plus the argv with `--lang` removed. */
export interface ResolvedCliLocale {
  locale: Locale;
  argv: string[];
  error: CliLocaleError | null;
}

/**
 * Map a POSIX or BCP-47 language tag to one of the CLI's catalogs.
 *
 * Accepts the forms a shell actually hands over: `zh_CN.UTF-8`, `zh-CN`,
 * `en_US.UTF-8`, `zh-Hant-TW`, and plain `zh` / `en`. `C`, `POSIX` and anything
 * that is not Chinese or English answer `null`; the caller decides the fallback.
 */
export function localeFromTag(tag: string | null | undefined): Locale | null {
  if (typeof tag !== "string") return null;
  const trimmed = tag.trim();
  if (trimmed === "") return null;
  // Lowercase and POSIX-ify first, then drop an encoding (`.UTF-8`) or modifier
  // (`@euro`) suffix. `zh_CN.UTF-8` becomes `zh-cn`.
  const normalized = trimmed.toLowerCase().replace(/_/g, "-").split(/[.@]/, 1)[0];
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  return null;
}

/**
 * The OS language tag, using the conventional precedence.
 *
 * `LC_ALL` wins over `LC_MESSAGES`, which wins over `LANG`; when none is set the
 * runtime's resolved locale answers. Returning the raw tag (rather than a
 * `Locale`) keeps `localeFromTag` the one place that decides what a tag means.
 */
export function detectSystemLanguage(
  // `process.env` is typed with an index signature this function does not need, so the
  // default is named as the narrow shape it actually reads.
  env: LocaleEnvironment = process.env as unknown as LocaleEnvironment,
  systemLocale = Intl.DateTimeFormat().resolvedOptions().locale,
): string {
  for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"] as const) {
    const value = env[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return systemLocale;
}

const LANG_FLAG = "--lang";
const LANG_FLAG_PREFIX = `${LANG_FLAG}=`;

/**
 * Resolve the CLI language and strip every `--lang` occurrence from argv.
 *
 * Precedence: an explicit flag, then `COURIER_LANG`, then the OS language, then
 * English. `--lang` may appear before or after the subcommand (the caller strips
 * it before commander parses), accepts both `--lang en` and `--lang=en`, and the
 * last occurrence wins. On a refused explicit value the error is returned while
 * `locale` stays the OS choice, so the caller can print the error in the language
 * the user would have seen without the bad flag.
 */
export function resolveCliLocale(
  argv: readonly string[],
  envValue: string | undefined = process.env.COURIER_LANG,
  systemLanguage: string = detectSystemLanguage(),
): ResolvedCliLocale {
  const osLocale = localeFromTag(systemLanguage) ?? "en";
  const remaining: string[] = [];
  let flagValue: string | undefined;
  let flagError: CliLocaleError | null = null;
  let sawFlag = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") {
      remaining.push(...argv.slice(index));
      break;
    }
    if (argument === LANG_FLAG) {
      sawFlag = true;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) {
        flagValue = undefined;
        flagError = { kind: "missing", value: "" };
      } else {
        flagValue = next;
        flagError = null;
        index += 1;
      }
      continue;
    }
    if (argument.startsWith(LANG_FLAG_PREFIX)) {
      sawFlag = true;
      const value = argument.slice(LANG_FLAG_PREFIX.length);
      if (value === "") {
        flagValue = undefined;
        flagError = { kind: "missing", value: "" };
      } else {
        flagValue = value;
        flagError = null;
      }
      continue;
    }
    remaining.push(argument);
  }

  if (sawFlag) {
    if (flagError !== null) return { locale: osLocale, argv: remaining, error: flagError };
    if (flagValue !== undefined) {
      const locale = localeFromTag(flagValue);
      if (locale === null) {
        return {
          locale: osLocale,
          argv: remaining,
          error: { kind: "invalid", value: flagValue },
        };
      }
      return { locale, argv: remaining, error: null };
    }
  }

  const env = envValue?.trim() ?? "";
  if (env !== "") {
    const locale = localeFromTag(env);
    if (locale === null) {
      return {
        locale: osLocale,
        argv: remaining,
        error: { kind: "invalid", value: env },
      };
    }
    return { locale, argv: remaining, error: null };
  }

  return { locale: osLocale, argv: remaining, error: null };
}

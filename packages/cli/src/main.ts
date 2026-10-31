#!/usr/bin/env bun
import { setLocale, t } from "./i18n";
import { detectSystemLanguage, resolveCliLocale } from "./i18n/locale";
import { createProgram } from "./program";

/**
 * The entry point only resolves the language and delegates the command surface.
 *
 * Language precedence is `--lang` > `COURIER_LANG` > the OS language > English.
 * The flag is stripped here, before commander parses, so it works before or after
 * the subcommand without commander rejecting it as unknown. A refused explicit
 * value is reported in the language the user would have had without it, then the
 * process exits rather than falling back silently.
 */
const resolved = resolveCliLocale(
  process.argv.slice(2),
  process.env.COURIER_LANG,
  detectSystemLanguage(),
);
setLocale(resolved.locale);

if (resolved.error !== null) {
  const key =
    resolved.error.kind === "missing" ? "cli.error.missingLanguage" : "cli.error.invalidLanguage";
  console.error(t(key, { value: resolved.error.value }));
  process.exit(1);
}

createProgram().parse(resolved.argv, { from: "user" });

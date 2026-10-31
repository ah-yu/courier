import { describe, expect, it } from "vitest";
import { detectSystemLanguage, localeFromTag, resolveCliLocale } from "./locale";

/**
 * The CLI language is resolved before commander is built, so these are the rules
 * that decide which catalog every later message uses. They are pure functions on
 * purpose: the process environment is only read at the edges.
 */
describe("localeFromTag", () => {
  it("recognizes Chinese and English in POSIX and BCP-47 forms", () => {
    expect(localeFromTag("zh")).toBe("zh");
    expect(localeFromTag("zh_CN.UTF-8")).toBe("zh");
    expect(localeFromTag("zh-CN")).toBe("zh");
    expect(localeFromTag("zh_TW.UTF-8")).toBe("zh");
    expect(localeFromTag("zh-Hant-TW")).toBe("zh");
    expect(localeFromTag("en")).toBe("en");
    expect(localeFromTag("en_US.UTF-8")).toBe("en");
    expect(localeFromTag("en-GB")).toBe("en");
  });

  it("is case-insensitive and tolerates whitespace", () => {
    expect(localeFromTag(" ZH_cn.utf-8 ")).toBe("zh");
    expect(localeFromTag("EN_us")).toBe("en");
  });

  it("refuses C, POSIX, empty and unrelated languages", () => {
    expect(localeFromTag("C")).toBeNull();
    expect(localeFromTag("C.UTF-8")).toBeNull();
    expect(localeFromTag("POSIX")).toBeNull();
    expect(localeFromTag("fr_FR.UTF-8")).toBeNull();
    expect(localeFromTag("")).toBeNull();
    expect(localeFromTag(undefined)).toBeNull();
    expect(localeFromTag(null)).toBeNull();
  });

  it("does not treat a language simply starting with the letters as English", () => {
    expect(localeFromTag("enochian")).toBeNull();
    expect(localeFromTag("zhuang")).toBeNull();
  });
});

describe("detectSystemLanguage", () => {
  it("prefers LC_ALL, then LC_MESSAGES, then LANG", () => {
    expect(
      detectSystemLanguage(
        { LC_ALL: "zh_CN.UTF-8", LC_MESSAGES: "en_US.UTF-8", LANG: "fr_FR.UTF-8" },
        "en-US",
      ),
    ).toBe("zh_CN.UTF-8");
    expect(
      detectSystemLanguage(
        { LC_ALL: "", LC_MESSAGES: "zh_TW.UTF-8", LANG: "fr_FR.UTF-8" },
        "en-US",
      ),
    ).toBe("zh_TW.UTF-8");
    expect(detectSystemLanguage({ LANG: "en_GB.UTF-8" }, "en-US")).toBe("en_GB.UTF-8");
  });

  it("falls back to the runtime locale when no variable is set", () => {
    expect(detectSystemLanguage({}, "zh-CN")).toBe("zh-CN");
  });
});

describe("resolveCliLocale", () => {
  it("follows the OS language by default", () => {
    expect(resolveCliLocale([], undefined, "zh_CN.UTF-8")).toEqual({
      locale: "zh",
      argv: [],
      error: null,
    });
    expect(resolveCliLocale([], undefined, "en_US.UTF-8")).toEqual({
      locale: "en",
      argv: [],
      error: null,
    });
  });

  it("treats C, POSIX and unknown OS locales as English", () => {
    for (const language of ["C", "POSIX", "fr_FR.UTF-8"]) {
      expect(resolveCliLocale([], undefined, language).locale).toBe("en");
    }
  });

  it("lets COURIER_LANG override the OS", () => {
    expect(resolveCliLocale([], "zh", "en_US.UTF-8").locale).toBe("zh");
    expect(resolveCliLocale([], "en_GB.UTF-8", "zh_CN.UTF-8").locale).toBe("en");
  });

  it("lets an explicit --lang override COURIER_LANG and strips it from argv", () => {
    expect(resolveCliLocale(["status", "--lang", "en"], "zh", "zh_CN.UTF-8")).toEqual({
      locale: "en",
      argv: ["status"],
      error: null,
    });
    expect(resolveCliLocale(["--lang=zh", "status"], "en", "en_US.UTF-8")).toEqual({
      locale: "zh",
      argv: ["status"],
      error: null,
    });
  });

  it("supports the flag after the subcommand and in both forms", () => {
    expect(resolveCliLocale(["vault", "connect", "--lang=en"]).argv).toEqual(["vault", "connect"]);
    expect(resolveCliLocale(["vault", "--lang", "zh", "connect"]).locale).toBe("zh");
  });

  it("uses the last --lang when it is repeated", () => {
    expect(resolveCliLocale(["--lang=zh", "status", "--lang", "en"]).locale).toBe("en");
    expect(resolveCliLocale(["--lang=en", "status", "--lang=zh"]).locale).toBe("zh");
  });

  it("leaves everything after -- alone", () => {
    expect(resolveCliLocale(["status", "--", "--lang", "en"], undefined, "zh")).toEqual({
      locale: "zh",
      argv: ["status", "--", "--lang", "en"],
      error: null,
    });
  });

  it("reports a missing value but keeps the OS language", () => {
    expect(resolveCliLocale(["status", "--lang"], undefined, "zh_CN.UTF-8")).toEqual({
      locale: "zh",
      argv: ["status"],
      error: { kind: "missing", value: "" },
    });
    expect(resolveCliLocale(["status", "--lang="], undefined, "zh_CN.UTF-8").error).toEqual({
      kind: "missing",
      value: "",
    });
    expect(resolveCliLocale(["status", "--lang", "--json"], undefined, "en")).toEqual({
      locale: "en",
      argv: ["status", "--json"],
      error: { kind: "missing", value: "" },
    });
  });

  it("reports an unsupported explicit value but keeps the OS language", () => {
    expect(resolveCliLocale(["--lang", "fr"], undefined, "zh_CN.UTF-8")).toEqual({
      locale: "zh",
      argv: [],
      error: { kind: "invalid", value: "fr" },
    });
    expect(resolveCliLocale([], "fr_FR", "en_US.UTF-8")).toEqual({
      locale: "en",
      argv: [],
      error: { kind: "invalid", value: "fr_FR" },
    });
  });

  it("lets a valid flag win over an invalid COURIER_LANG", () => {
    expect(resolveCliLocale(["--lang=en"], "fr", "zh_CN.UTF-8")).toEqual({
      locale: "en",
      argv: [],
      error: null,
    });
  });

  it("treats an empty COURIER_LANG as unset", () => {
    expect(resolveCliLocale([], "   ", "zh_CN.UTF-8").locale).toBe("zh");
  });
});

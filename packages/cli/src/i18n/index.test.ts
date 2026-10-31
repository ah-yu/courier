import { afterEach, describe, expect, it } from "vitest";
import { en, getLocale, plural, setLocale, t, zh, type MessageKey } from "./index";

/**
 * The catalogs are the entire user-facing surface of the CLI, so their shape is
 * pinned here: every key exists in both languages, English is actually English,
 * a value that was left untranslated has to be acknowledged explicitly, and every
 * template can be rendered without a leftover placeholder.
 */

/** Values that are legitimately identical in both catalogs. */
const ALLOWED_IDENTICAL = new Set<string>(["Obsidian"]);

afterEach(() => {
  setLocale("en");
});

describe("the catalogs", () => {
  it("provides every key in both languages", () => {
    expect(new Set(Object.keys(en))).toEqual(new Set(Object.keys(zh)));
    expect(getLocale()).toBe("en");
  });

  it("has no empty message", () => {
    for (const [key, value] of Object.entries(zh)) {
      expect(value.trim(), `zh ${key}`).not.toBe("");
    }
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim(), `en ${key}`).not.toBe("");
    }
  });

  it("does not leave Chinese in the English catalog", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value, `en ${key}`).not.toMatch(/[\u3400-\u9fff]/);
    }
  });

  it("only repeats a value across languages when it is deliberately shared", () => {
    for (const key of Object.keys(zh) as MessageKey[]) {
      if (zh[key] === en[key]) {
        expect(ALLOWED_IDENTICAL.has(zh[key]), `shared value for ${key}: ${zh[key]}`).toBe(true);
      }
    }
  });

  it("renders every template with every placeholder supplied", () => {
    const params = new Proxy({} as Record<string, string>, {
      get: () => "value",
    });
    for (const locale of ["zh", "en"] as const) {
      setLocale(locale);
      for (const key of Object.keys(zh) as MessageKey[]) {
        expect(t(key, params), `${locale} ${key}`).not.toMatch(/\{[a-zA-Z]+\}/);
      }
    }
  });
});

describe("t", () => {
  it("returns a static message unchanged", () => {
    expect(t("common.none")).toBe("(none)");
    setLocale("zh");
    expect(t("common.none")).toBe("（无）");
  });

  it("replaces a placeholder once and leaves other text alone", () => {
    setLocale("en");
    expect(t("cli.register.saved", { deviceName: "NAS" })).toBe('Saved device name "NAS".');
  });

  it("does not re-scan an inserted value for placeholders", () => {
    setLocale("en");
    expect(t("cli.register.saved", { deviceName: "{other}" })).toBe('Saved device name "{other}".');
  });

  it("keeps an unknown placeholder visible instead of dropping it", () => {
    setLocale("en");
    expect(t("cli.register.saved")).toBe('Saved device name "{deviceName}".');
  });

  it("keeps replacement-pattern characters in a value literal", () => {
    setLocale("en");
    expect(t("cli.register.saved", { deviceName: "$& $1" })).toBe('Saved device name "$& $1".');
  });
});

describe("plural", () => {
  it("uses the singular message for exactly one", () => {
    setLocale("en");
    expect(
      plural("cli.status.conflicts.one", "cli.status.conflicts.other", 1, {
        files: "a.md",
      }),
    ).toBe("1 parked file: a.md");
  });

  it("uses the plural message for zero and more than one", () => {
    setLocale("en");
    expect(
      plural("cli.status.conflicts.one", "cli.status.conflicts.other", 0, {
        files: "none",
      }),
    ).toBe("0 parked files: none");
    expect(
      plural("cli.status.conflicts.one", "cli.status.conflicts.other", 2, {
        files: "a.md, b.md",
      }),
    ).toBe("2 parked files: a.md, b.md");
  });

  it("always supplies count to the template", () => {
    setLocale("zh");
    expect(
      plural("cli.status.conflicts.one", "cli.status.conflicts.other", 3, {
        files: "a、b、c",
      }),
    ).toBe("3 个冲突副本：a、b、c");
  });
});

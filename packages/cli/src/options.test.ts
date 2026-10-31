import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "./i18n";
import { parseIntervalMinutes, selectVaults } from "./options";
import type { CliConfig, CliVault } from "./config";

/**
 * The CLI's argument decisions.
 *
 * The command layer is in `program.ts`, but these decisions are pure functions and live
 * here because one of them was wrong: `--interval 5m` produced `NaN`, and a daemon whose
 * periodic reconcile is silently off has lost its only catch-up mechanism (the server
 * keeps no backlog for a subscriber).
 */

afterEach(() => {
  setLocale("en");
});

function vault(id: string, path = `/mnt/${id}`): CliVault {
  return { vaultId: id, vaultPath: path, encryptionKeyB64: "a2V5" };
}

function config(vaults: CliVault[] = [vault("v1")]): CliConfig {
  return {
    serverUrl: "http://srv",
    userKey: "ck_x",
    deviceName: "nas",
    vaults,
  };
}

describe("parseIntervalMinutes", () => {
  it("reads a number of minutes", () => {
    expect(parseIntervalMinutes("30")).toBe(30);
    expect(parseIntervalMinutes(" 5 ")).toBe(5);
    expect(parseIntervalMinutes("0.5")).toBe(0.5);
  });

  it("takes 0 as 'no periodic reconcile'", () => {
    expect(parseIntervalMinutes("0")).toBe(0);
  });

  it("refuses a value that is not a number instead of reading it as off", () => {
    // `Number("5m")` is NaN, and `NaN > 0` is false: the daemon used to come up with no
    // interval at all and say nothing about it.
    expect(() => parseIntervalMinutes("5m")).toThrow(/non-negative number of minutes/);
    expect(() => parseIntervalMinutes("")).toThrow(/non-negative number of minutes/);
    expect(() => parseIntervalMinutes("abc")).toThrow(/non-negative number of minutes/);
  });

  it("refuses a negative value", () => {
    expect(() => parseIntervalMinutes("-1")).toThrow(/non-negative number of minutes/);
  });
});

describe("selectVaults", () => {
  it("returns the only binding when there is one", () => {
    expect(selectVaults(config())).toEqual([vault("v1")]);
  });

  it("selects exactly one by id", () => {
    const vaults = [vault("v1"), vault("v2")];
    expect(selectVaults(config(vaults), "v2")).toEqual([vault("v2")]);
  });

  it("refuses to guess when several vaults are bound", () => {
    expect(() => selectVaults(config([vault("v1"), vault("v2")]))).toThrow(
      "Each runs in its own process; pass `--vault <id>`",
    );
  });

  it("names the command that fixes an unbound config", () => {
    expect(() => selectVaults(config([]))).toThrow("courier-cli vault connect");
  });

  it("refuses an unknown id instead of syncing nothing", () => {
    expect(() => selectVaults(config(), "nope")).toThrow('No vault "nope" is bound');
  });
});

describe("the Chinese error copy", () => {
  it("renders the validation failures in Chinese", () => {
    setLocale("zh");

    expect(() => parseIntervalMinutes("5m")).toThrow(/`--interval` 需要非负的分钟数/);
    expect(() => selectVaults(config([]))).toThrow(
      "尚未绑定远程库。请先运行 `courier-cli vault connect`。",
    );
    expect(() => selectVaults(config([vault("v1"), vault("v2")]))).toThrow(
      "每个 Vault 由独立进程同步",
    );
  });
});

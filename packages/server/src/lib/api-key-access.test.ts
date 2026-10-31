import { describe, expect, it } from "vitest";
import {
  assertApiKeyActive,
  formatScopes,
  hasScope,
  isApiKeyExpired,
  parseExpiresIn,
  parseScopeList,
  parseScopes,
} from "./api-key-access";
import { KeyExpiredError } from "./errors";

describe("parseScopes / formatScopes", () => {
  it("reads a stored list in canonical order, dropping unknown names", () => {
    expect(parseScopes("users,status")).toEqual(["status", "users"]);
    expect(parseScopes("admin")).toEqual(["admin"]);
    // An unknown scope (written by a newer binary) grants nothing here.
    expect(parseScopes("status,teleport")).toEqual(["status"]);
    expect(parseScopes(null)).toEqual([]);
    expect(parseScopes("")).toEqual([]);
  });

  it("serializes a list and keeps an empty one empty", () => {
    expect(formatScopes(["users", "status", "users"])).toBe("status,users");
    expect(formatScopes([])).toBe("");
  });
});

describe("hasScope", () => {
  it("treats admin as every scope", () => {
    expect(hasScope("admin", "users")).toBe(true);
    expect(hasScope("admin", "status")).toBe(true);
  });

  it("requires the exact scope otherwise", () => {
    expect(hasScope("status,users", "users")).toBe(true);
    expect(hasScope("status,users", "admin")).toBe(false);
    expect(hasScope("status", "users")).toBe(false);
    expect(hasScope(null, "status")).toBe(false);
  });
});

describe("isApiKeyExpired / assertApiKeyActive", () => {
  const now = new Date("2026-06-01T00:00:00.000Z");

  it("treats a null expiry as never expiring", () => {
    expect(isApiKeyExpired({ expiresAt: null }, now)).toBe(false);
    expect(() => assertApiKeyActive({ expiresAt: null }, now)).not.toThrow();
  });

  it("treats an unparseable expiry as expired", () => {
    expect(isApiKeyExpired({ expiresAt: "not a date" }, now)).toBe(true);
    expect(() => assertApiKeyActive({ expiresAt: "not a date" }, now)).toThrow(KeyExpiredError);
  });

  it("compares an expiry against now", () => {
    expect(isApiKeyExpired({ expiresAt: "2026-06-02T00:00:00.000Z" }, now)).toBe(false);
    expect(isApiKeyExpired({ expiresAt: "2026-06-01T00:00:00.000Z" }, now)).toBe(true);
    expect(() => assertApiKeyActive({ expiresAt: "2026-05-31T00:00:00.000Z" }, now)).toThrow(
      KeyExpiredError,
    );
  });
});

describe("parseScopeList", () => {
  it("parses a comma-separated list", () => {
    expect(parseScopeList("status,users")).toEqual(["status", "users"]);
    expect(parseScopeList(" admin ")).toEqual(["admin"]);
  });

  it("rejects an unknown name or an empty list outright", () => {
    expect(parseScopeList("status,root")).toBeNull();
    expect(parseScopeList("")).toBeNull();
    expect(parseScopeList(" , ")).toBeNull();
  });
});

describe("parseExpiresIn", () => {
  const now = new Date("2026-06-01T00:00:00.000Z");

  it("turns a duration into an absolute timestamp", () => {
    expect(parseExpiresIn("30m", now)).toBe("2026-06-01T00:30:00.000Z");
    expect(parseExpiresIn("12h", now)).toBe("2026-06-01T12:00:00.000Z");
    expect(parseExpiresIn("7d", now)).toBe("2026-06-08T00:00:00.000Z");
  });

  it("rejects anything that is not a positive duration", () => {
    expect(parseExpiresIn("12", now)).toBeNull();
    expect(parseExpiresIn("h", now)).toBeNull();
    expect(parseExpiresIn("0d", now)).toBeNull();
    expect(parseExpiresIn("-1h", now)).toBeNull();
    expect(parseExpiresIn("", now)).toBeNull();
  });
});

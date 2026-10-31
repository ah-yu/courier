import { describe, expect, it, vi } from "vitest";
import { authenticateUserHeader, authenticateUserKey, bearerToken } from "./user-credentials";
import type { FindUserByKeyFn, UserRow } from "../handlers/users-handlers";
import { KeyExpiredError, UnauthorizedError } from "./errors";

/**
 * The credential check the three callers share (the two HTTP middlewares and the
 * WebSocket `subscribe` handler).
 *
 * What matters here is the split the routes depend on: a missing/garbled header
 * and a wrong credential family are `UnauthorizedError`s the middlewares turn
 * into 401, an unknown key is refused, and an **expired** key is refused before
 * any route gets to look at the request.
 */
function mockUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "u-1",
    name: "Alice",
    key: "ck_secret",
    storageBytesLimit: null,
    retentionDays: null,
    maxFileBytes: 50 * 1024 * 1024,
    maxVaults: 1,
    expiresAt: null,
    disabled: false,
    createdAt: new Date("2026-06-10T00:00:00.000Z"),
    ...overrides,
  };
}

describe("bearerToken", () => {
  it("returns the token for the expected family", () => {
    expect(bearerToken("Bearer ck_abc", "ck_")).toBe("ck_abc");
    expect(bearerToken("Bearer ak_abc", "ak_")).toBe("ak_abc");
  });

  it("refuses a missing header and another credential family", () => {
    expect(() => bearerToken(null, "ck_")).toThrow(UnauthorizedError);
    expect(() => bearerToken("ck_abc", "ck_")).toThrow(UnauthorizedError);
    expect(() => bearerToken("Bearer ak_abc", "ck_")).toThrow(UnauthorizedError);
  });
});

describe("authenticateUserKey", () => {
  it("resolves the account a key belongs to", async () => {
    const findUserByKey = vi.fn<FindUserByKeyFn>().mockResolvedValue(mockUser());
    await expect(authenticateUserKey("ck_secret", findUserByKey)).resolves.toMatchObject({
      id: "u-1",
    });
  });

  it("refuses a host key without asking the database", async () => {
    const findUserByKey = vi.fn<FindUserByKeyFn>();
    await expect(authenticateUserKey("ak_host", findUserByKey)).rejects.toThrow(UnauthorizedError);
    expect(findUserByKey).not.toHaveBeenCalled();
  });

  it("refuses an unknown key", async () => {
    const findUserByKey = vi.fn<FindUserByKeyFn>().mockResolvedValue(undefined);
    await expect(authenticateUserKey("ck_gone", findUserByKey)).rejects.toThrow(
      "Invalid or expired user key",
    );
  });

  it("refuses an expired key", async () => {
    const findUserByKey = vi
      .fn<FindUserByKeyFn>()
      .mockResolvedValue(mockUser({ expiresAt: "2020-01-01T00:00:00.000Z" }));
    await expect(authenticateUserKey("ck_secret", findUserByKey)).rejects.toThrow(KeyExpiredError);
  });
});

describe("authenticateUserHeader", () => {
  it("accepts the Authorization header form", async () => {
    const findUserByKey = vi.fn<FindUserByKeyFn>().mockResolvedValue(mockUser());
    await expect(authenticateUserHeader("Bearer ck_secret", findUserByKey)).resolves.toMatchObject({
      id: "u-1",
    });
  });

  it("refuses a host key sent to a user route", async () => {
    const findUserByKey = vi.fn<FindUserByKeyFn>();
    await expect(authenticateUserHeader("Bearer ak_host", findUserByKey)).rejects.toThrow(
      UnauthorizedError,
    );
  });
});

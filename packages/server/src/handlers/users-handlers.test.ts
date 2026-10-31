import { describe, expect, it, vi } from "vitest";
import {
  createUser,
  listUsers,
  updateUser,
  deleteUser,
  revealUserKey,
  toUserSummary,
} from "./users-handlers";
import type {
  InsertUserFn,
  ListUsersFn,
  FindUserByIdFn,
  UpdateUserDeps,
  UpdateUserFn,
  DeleteUserFn,
  UserRow,
  UserStorageBytesFn,
  UserVaultCountFn,
} from "./users-handlers";
import { NotFoundError, ValidationError } from "../lib/errors";

/** The clock every validity test reads, so "in the past" is not a moving target. */
const NOW = new Date("2026-10-28T00:00:00.000Z");

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

/** The facts an edit checks, with every dependency a mock unless a case says otherwise. */
function updateDeps(overrides: Partial<UpdateUserDeps> = {}): UpdateUserDeps {
  return {
    find: vi.fn<FindUserByIdFn>().mockResolvedValue(mockUser()),
    update: vi.fn<UpdateUserFn>().mockResolvedValue(mockUser()),
    usedBytes: vi.fn<UserStorageBytesFn>().mockResolvedValue(0),
    vaultCount: vi.fn<UserVaultCountFn>().mockResolvedValue(0),
    now: () => NOW,
    ...overrides,
  };
}

describe("createUser", () => {
  it("inserts a user and returns the full key once", async () => {
    const insert = vi.fn<InsertUserFn>().mockResolvedValue({
      createdAt: new Date("2026-06-11T00:00:00.000Z"),
    });

    const result = await createUser(
      { name: "Alice", storageBytesLimit: 1_000_000, retentionDays: 30 },
      insert,
    );

    expect(result.name).toBe("Alice");
    expect(result.key).toMatch(/^ck_/);
    expect(result.maskedKey).toContain("****");
    expect(result.maskedKey).not.toBe(result.key);
    expect(result.storageBytesLimit).toBe(1_000_000);
    expect(result.retentionDays).toBe(30);
    expect(result.maxFileBytes).toBe(50 * 1024 * 1024);
    expect(result.maxVaults).toBe(1);
    expect(result.expiresAt).toBeNull();
    expect(insert).toHaveBeenCalledTimes(1);
    const data = insert.mock.calls[0][0];
    expect(data.id).toBe(result.id);
    expect(data.key).toBe(result.key);
    expect(data.maxFileBytes).toBe(50 * 1024 * 1024);
    expect(data.maxVaults).toBe(1);
  });

  it("keeps an explicit per-key file cap", async () => {
    const insert = vi.fn<InsertUserFn>().mockResolvedValue({
      createdAt: new Date("2026-06-11T00:00:00.000Z"),
    });

    const result = await createUser({ name: "Alice", maxFileBytes: 0 }, insert);

    expect(result.maxFileBytes).toBe(0);
    expect(insert.mock.calls[0][0].maxFileBytes).toBe(0);
  });

  it("keeps an explicit vault allowance, including unlimited", async () => {
    const insert = vi.fn<InsertUserFn>().mockResolvedValue({
      createdAt: new Date("2026-06-11T00:00:00.000Z"),
    });

    const result = await createUser({ name: "Alice", maxVaults: 0 }, insert);

    expect(result.maxVaults).toBe(0);
    expect(insert.mock.calls[0][0].maxVaults).toBe(0);
  });
});

describe("toUserSummary", () => {
  it("never leaks the raw key", () => {
    const summary = toUserSummary(mockUser(), 42, 1);
    expect(summary).not.toHaveProperty("key");
    expect(summary.maskedKey).toBe("ck_s****t");
    expect(summary.usedBytes).toBe(42);
    expect(summary.vaultsCount).toBe(1);
    expect(summary.maxVaults).toBe(1);
  });
});

describe("listUsers", () => {
  it("maps rows to summaries and includes storage and vault counts when given", async () => {
    const list = vi.fn<ListUsersFn>().mockResolvedValue([mockUser()]);
    const used = vi.fn<UserStorageBytesFn>().mockResolvedValue(123);
    const owned = vi.fn<UserVaultCountFn>().mockResolvedValue(1);

    const result = await listUsers(list, used, owned);

    expect(result.users[0].usedBytes).toBe(123);
    expect(result.users[0].vaultsCount).toBe(1);
    expect(result.users[0]).not.toHaveProperty("key");
    expect(result.users[0].maskedKey).toBe("ck_s****t");
  });
});

describe("revealUserKey", () => {
  it("returns the full key of an existing account", async () => {
    const find = vi.fn<FindUserByIdFn>().mockResolvedValue(mockUser());
    await expect(revealUserKey("u-1", find)).resolves.toEqual({ key: "ck_secret" });
  });

  it("throws NotFound for an account that does not exist", async () => {
    const find = vi.fn<FindUserByIdFn>().mockResolvedValue(undefined);
    await expect(revealUserKey("nope", find)).rejects.toThrow(NotFoundError);
  });
});

describe("updateUser", () => {
  it("throws NotFound when the user does not exist", async () => {
    const deps = updateDeps({ find: vi.fn<FindUserByIdFn>().mockResolvedValue(undefined) });
    await expect(updateUser("nope", { name: "X" }, deps)).rejects.toThrow(NotFoundError);
  });

  it("applies the patch and returns a summary", async () => {
    const deps = updateDeps({
      update: vi
        .fn<UpdateUserFn>()
        .mockResolvedValue(mockUser({ storageBytesLimit: 500, name: "Alice 2" })),
    });

    const result = await updateUser("u-1", { storageBytesLimit: 500 }, deps);

    expect(deps.update).toHaveBeenCalledWith("u-1", { storageBytesLimit: 500 });
    expect(result.name).toBe("Alice 2");
  });

  it("does not walk or count for a rename", async () => {
    // The usage walk visits every blob directory the account owns; a name-only edit
    // must not pay for it.
    const deps = updateDeps();
    await updateUser("u-1", { name: "Alice 2" }, deps);
    expect(deps.usedBytes).not.toHaveBeenCalled();
    expect(deps.vaultCount).not.toHaveBeenCalled();
  });

  it("refuses a storage cap below what the account already stores", async () => {
    const deps = updateDeps({
      usedBytes: vi.fn<UserStorageBytesFn>().mockResolvedValue(2048),
    });
    await expect(updateUser("u-1", { storageBytesLimit: 1024 }, deps)).rejects.toThrow(
      ValidationError,
    );
    expect(deps.update).not.toHaveBeenCalled();
  });

  it("accepts a storage cap exactly at the current usage", async () => {
    const deps = updateDeps({
      usedBytes: vi.fn<UserStorageBytesFn>().mockResolvedValue(1024),
    });
    await expect(updateUser("u-1", { storageBytesLimit: 1024 }, deps)).resolves.toBeDefined();
  });

  it("refuses a vault allowance below the vaults the account owns", async () => {
    const deps = updateDeps({ vaultCount: vi.fn<UserVaultCountFn>().mockResolvedValue(3) });
    await expect(updateUser("u-1", { maxVaults: 1 }, deps)).rejects.toThrow(ValidationError);
    expect(deps.update).not.toHaveBeenCalled();
  });

  it("accepts a vault allowance exactly at the number of vaults owned", async () => {
    // The boundary is "below the count", not "at it": an account holding three vaults and
    // allowed three is exactly full, which is the ordinary state.
    const deps = updateDeps({ vaultCount: vi.fn<UserVaultCountFn>().mockResolvedValue(3) });
    await expect(updateUser("u-1", { maxVaults: 3 }, deps)).resolves.toBeDefined();
  });

  it("keeps 0 meaning unlimited even with vaults owned", async () => {
    const deps = updateDeps({ vaultCount: vi.fn<UserVaultCountFn>().mockResolvedValue(3) });
    await expect(updateUser("u-1", { maxVaults: 0 }, deps)).resolves.toBeDefined();
    expect(deps.vaultCount).not.toHaveBeenCalled();
  });

  it("refuses an expiry that has already passed", async () => {
    const deps = updateDeps();
    await expect(
      updateUser("u-1", { expiresAt: "2026-10-27T23:59:59.000Z" }, deps),
    ).rejects.toThrow(ValidationError);
    expect(deps.update).not.toHaveBeenCalled();
  });

  it("refuses an expiry at the current instant, and accepts one after it", async () => {
    const deps = updateDeps();
    await expect(updateUser("u-1", { expiresAt: NOW.toISOString() }, deps)).rejects.toThrow(
      ValidationError,
    );
    await expect(
      updateUser("u-1", { expiresAt: "2026-10-28T23:59:59.000Z" }, deps),
    ).resolves.toBeDefined();
  });

  it("clearing a limit is never refused", async () => {
    const deps = updateDeps({
      usedBytes: vi.fn<UserStorageBytesFn>().mockResolvedValue(9999),
      vaultCount: vi.fn<UserVaultCountFn>().mockResolvedValue(9),
    });
    await expect(
      updateUser("u-1", { storageBytesLimit: null, expiresAt: null }, deps),
    ).resolves.toBeDefined();
  });
});

describe("deleteUser", () => {
  it("throws NotFound when the user does not exist", async () => {
    const find = vi.fn<FindUserByIdFn>().mockResolvedValue(undefined);
    await expect(deleteUser("nope", find, vi.fn())).rejects.toThrow(NotFoundError);
  });

  it("deletes an existing user and answers the vaults that went with it", async () => {
    const find = vi.fn<FindUserByIdFn>().mockResolvedValue(mockUser());
    const remove = vi.fn<DeleteUserFn>().mockResolvedValue(["v-1", "v-2"]);
    await expect(deleteUser("u-1", find, remove)).resolves.toEqual(["v-1", "v-2"]);
    expect(remove).toHaveBeenCalledWith("u-1");
  });
});

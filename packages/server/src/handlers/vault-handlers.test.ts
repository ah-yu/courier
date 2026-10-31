import { describe, expect, it, vi } from "vitest";
import {
  createVault,
  getEncryptionSalt,
  getKeyCheck,
  listVisibleVaults,
  deleteVaultOwned,
  renameVaultOwned,
} from "./vault-handlers";
import type {
  InsertVaultFn,
  FindVaultByIdFn,
  DeleteVaultByIdFn,
  ListVisibleVaultsFn,
  UpdateVaultNameFn,
} from "./vault-handlers";
import { NotFoundError, VaultLimitReachedError } from "../lib/errors";

function mockVault(overrides: Partial<ReturnType<typeof mockVaultRow>> = {}) {
  return mockVaultRow(overrides);
}

function mockVaultRow(
  overrides: Partial<{
    id: string;
    name: string;
    ownerUserId: string | null;
    encryptionSalt: string | null;
    keyCheck: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> = {},
) {
  return {
    id: "test-id",
    name: "Test Vault",
    ownerUserId: null,
    encryptionSalt: "",
    keyCheck: "",
    createdAt: new Date("2026-06-10T00:00:00.000Z"),
    updatedAt: new Date("2026-06-10T00:00:00.000Z"),
    ...overrides,
  };
}

describe("createVault", () => {
  it("inserts a vault and returns id, name, createdAt from DB", async () => {
    const dbCreatedAt = new Date("2026-06-11T12:00:00.000Z");
    const insertFn = vi.fn<InsertVaultFn>().mockResolvedValue({ createdAt: dbCreatedAt });

    const result = await createVault(
      {
        name: "My Vault",
        encryptionSalt: "esalt",
        keyCheck: "canary-ciphertext",
        ownerUserId: "u-1",
        maxVaults: 1,
      },
      insertFn,
    );

    expect(result).toHaveProperty("id");
    expect(result.name).toBe("My Vault");
    expect(result.createdAt).toBe(dbCreatedAt.toISOString());
    expect(result).not.toHaveProperty("token");

    expect(insertFn).toHaveBeenCalledTimes(1);
    const data = insertFn.mock.calls[0][0];
    expect(data.name).toBe("My Vault");
    expect(data.encryptionSalt).toBe("esalt");
    expect(data.keyCheck).toBe("canary-ciphertext");
    expect(data.ownerUserId).toBe("u-1");
    expect(data.maxVaults).toBe(1);
    expect(data.id).toBe(result.id);
  });

  it("refuses a vault when the owner's allowance is full", async () => {
    const insertFn = vi.fn<InsertVaultFn>().mockResolvedValue(undefined);

    await expect(
      createVault(
        {
          name: "One too many",
          encryptionSalt: "esalt",
          keyCheck: "canary-ciphertext",
          ownerUserId: "u-1",
          maxVaults: 1,
        },
        insertFn,
      ),
    ).rejects.toThrow(VaultLimitReachedError);
  });

  it("leaves a legacy (owner-less) vault uncounted", async () => {
    const insertFn = vi.fn<InsertVaultFn>().mockResolvedValue({
      createdAt: new Date("2026-06-11T12:00:00.000Z"),
    });

    await createVault(
      {
        name: "Legacy",
        encryptionSalt: "esalt",
        keyCheck: "canary-ciphertext",
        ownerUserId: null,
        maxVaults: 1,
      },
      insertFn,
    );

    expect(insertFn.mock.calls[0][0].maxVaults).toBe(1);
  });
});

describe("getEncryptionSalt", () => {
  it("returns encryptionSalt when vault exists", async () => {
    const findById = vi
      .fn<FindVaultByIdFn>()
      .mockResolvedValue(mockVault({ encryptionSalt: "my-enc-salt" }));

    const result = await getEncryptionSalt("test-id", findById);

    expect(result.encryptionSalt).toBe("my-enc-salt");
    expect(findById).toHaveBeenCalledWith("test-id");
  });

  it("throws NotFoundError when vault does not exist", async () => {
    const findById = vi.fn<FindVaultByIdFn>().mockResolvedValue(undefined);

    await expect(getEncryptionSalt("missing-id", findById)).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError when vault has no encryptionSalt", async () => {
    const findById = vi
      .fn<FindVaultByIdFn>()
      .mockResolvedValue(mockVault({ encryptionSalt: null }));

    await expect(getEncryptionSalt("test-id", findById)).rejects.toThrow(NotFoundError);
  });
});

describe("getKeyCheck", () => {
  it("returns keyCheck when vault exists", async () => {
    const findById = vi
      .fn<FindVaultByIdFn>()
      .mockResolvedValue(mockVault({ keyCheck: "my-canary" }));

    const result = await getKeyCheck("test-id", findById);

    expect(result.keyCheck).toBe("my-canary");
    expect(findById).toHaveBeenCalledWith("test-id");
  });

  it("throws NotFoundError when vault does not exist", async () => {
    const findById = vi.fn<FindVaultByIdFn>().mockResolvedValue(undefined);

    await expect(getKeyCheck("missing-id", findById)).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError when vault has no keyCheck", async () => {
    const findById = vi.fn<FindVaultByIdFn>().mockResolvedValue(mockVault({ keyCheck: null }));

    await expect(getKeyCheck("test-id", findById)).rejects.toThrow(NotFoundError);
  });
});

describe("listVisibleVaults", () => {
  it("returns the vaults the user may access", async () => {
    const listFn = vi
      .fn<ListVisibleVaultsFn>()
      .mockResolvedValue([{ id: "v1", name: "Mine", createdAt: new Date("2026-06-10T00:00:00Z") }]);

    const result = await listVisibleVaults("u-1", listFn);

    expect(listFn).toHaveBeenCalledWith("u-1");
    expect(result.vaults).toEqual([
      { id: "v1", name: "Mine", createdAt: "2026-06-10T00:00:00.000Z" },
    ]);
  });
});

describe("renameVaultOwned / deleteVaultOwned", () => {
  it("renames a vault the user owns", async () => {
    const findById = vi.fn<FindVaultByIdFn>().mockResolvedValue(mockVault({ ownerUserId: "u-1" }));
    const updateFn = vi.fn<UpdateVaultNameFn>().mockResolvedValue({ id: "v1", name: "Renamed" });

    const result = await renameVaultOwned("v1", "u-1", "Renamed", findById, updateFn);

    expect(result).toEqual({ id: "v1", name: "Renamed" });
  });

  it("answers a vault owned by someone else as not found", async () => {
    // Not `Unauthorized`: the refusal must not read as "your key is dead", and it must
    // not confirm that someone else's vault id exists.
    const findById = vi.fn<FindVaultByIdFn>().mockResolvedValue(mockVault({ ownerUserId: "u-9" }));
    const updateFn = vi.fn<UpdateVaultNameFn>();

    await expect(renameVaultOwned("v1", "u-1", "X", findById, updateFn)).rejects.toThrow(
      NotFoundError,
    );
    expect(updateFn).not.toHaveBeenCalled();
  });

  it("deletes a legacy vault from any user", async () => {
    const findById = vi.fn<FindVaultByIdFn>().mockResolvedValue(mockVault({ ownerUserId: null }));
    const deleteById = vi.fn<DeleteVaultByIdFn>();

    await deleteVaultOwned("v1", "u-1", findById, deleteById);

    expect(deleteById).toHaveBeenCalledWith("v1");
  });

  it("throws NotFound when the vault does not exist", async () => {
    const findById = vi.fn<FindVaultByIdFn>().mockResolvedValue(undefined);

    await expect(deleteVaultOwned("missing", "u-1", findById, vi.fn())).rejects.toThrow(
      NotFoundError,
    );
  });
});

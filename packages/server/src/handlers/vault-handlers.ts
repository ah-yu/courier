import type {
  CreateVaultResponse,
  ListVaultsResponse,
  VaultEncryptionSaltResponse,
  VaultKeyCheckResponse,
} from "@courier/shared";
import { generateVaultId } from "../lib/token";
import { NotFoundError, VaultLimitReachedError } from "../lib/errors";
import { canAccessVault } from "../lib/vault-access";

// ── Action types (db operations injected by the caller) ──

/** A vault row as the handlers see it, with both timestamps already `Date`. */
export interface VaultRow {
  id: string;
  name: string;
  ownerUserId: string | null;
  encryptionSalt: string | null;
  keyCheck: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type InsertVaultFn = (data: {
  id: string;
  name: string;
  encryptionSalt: string;
  keyCheck: string;
  ownerUserId: string | null;
  /** The owner's allowance (`0` = unlimited); the insert enforces it atomically. */
  maxVaults: number;
}) => Promise<{ createdAt: Date } | undefined>;

export type FindVaultByIdFn = (id: string) => Promise<VaultRow | undefined>;

export type DeleteVaultByIdFn = (id: string) => Promise<void>;

/** List vaults a user may access: their own or legacy (owner-less) ones. */
export type ListVisibleVaultsFn = (
  userId: string,
) => Promise<Array<{ id: string; name: string; createdAt: Date }>>;

export type UpdateVaultNameFn = (id: string, name: string) => Promise<{ id: string; name: string }>;

// ── Create Vault ──

interface CreateVaultInput {
  name: string;
  encryptionSalt: string;
  keyCheck: string;
  ownerUserId: string | null;
  /** How many vaults the owner may have (`0` = unlimited). */
  maxVaults: number;
}

/**
 * Create a vault, within its owner's allowance.
 *
 * The count and the insert happen in one transaction inside `insertVault`, so
 * two requests for the same key cannot both see a free slot; the `undefined`
 * result is "the allowance is full", not a database failure.
 */
export async function createVault(
  input: CreateVaultInput,
  insertVault: InsertVaultFn,
): Promise<CreateVaultResponse> {
  const id = generateVaultId();

  const created = await insertVault({
    id,
    name: input.name,
    encryptionSalt: input.encryptionSalt,
    keyCheck: input.keyCheck,
    ownerUserId: input.ownerUserId,
    maxVaults: input.maxVaults,
  });
  if (!created) {
    throw new VaultLimitReachedError(
      `This user key already owns ${input.maxVaults} vault${input.maxVaults === 1 ? "" : "s"}, ` +
        `its limit. Raise maxVaults on the account to create another.`,
    );
  }

  return {
    id,
    name: input.name,
    createdAt: created.createdAt.toISOString(),
  };
}

// ── Get Encryption Salt ──

export async function getEncryptionSalt(
  id: string,
  findById: FindVaultByIdFn,
): Promise<VaultEncryptionSaltResponse> {
  const vault = await findById(id);
  if (!vault) {
    throw new NotFoundError("Vault");
  }
  if (!vault.encryptionSalt) {
    throw new NotFoundError("Encryption salt");
  }
  return { encryptionSalt: vault.encryptionSalt };
}

// ── Get Key Check ──

export async function getKeyCheck(
  id: string,
  findById: FindVaultByIdFn,
): Promise<VaultKeyCheckResponse> {
  const vault = await findById(id);
  if (!vault) {
    throw new NotFoundError("Vault");
  }
  if (!vault.keyCheck) {
    throw new NotFoundError("Key check");
  }
  return { keyCheck: vault.keyCheck };
}

// ── List Vaults ──

/** List vaults visible to a user: their own plus legacy (owner-less) vaults. */
export async function listVisibleVaults(
  userId: string,
  listFn: ListVisibleVaultsFn,
): Promise<ListVaultsResponse> {
  const vaults = await listFn(userId);
  return {
    vaults: vaults.map((v) => ({
      id: v.id,
      name: v.name,
      createdAt: v.createdAt.toISOString(),
    })),
  };
}

async function requireManageableVault(
  id: string,
  userId: string,
  findFn: FindVaultByIdFn,
): Promise<VaultRow> {
  const vault = await findFn(id);
  if (!vault) {
    throw new NotFoundError("Vault");
  }
  // A vault this account cannot see is answered exactly like one that does not exist:
  // its existence is not this account's business, and the sync routes give the same
  // answer so a client never reads "not yours" as "your key is dead".
  if (!canAccessVault(vault, userId)) {
    throw new NotFoundError("Vault");
  }
  return vault;
}

// ── Rename Vault ──

export async function renameVaultOwned(
  id: string,
  userId: string,
  name: string,
  findFn: FindVaultByIdFn,
  updateFn: UpdateVaultNameFn,
): Promise<{ id: string; name: string }> {
  await requireManageableVault(id, userId, findFn);
  return updateFn(id, name);
}

// ── Delete Vault ──

export async function deleteVaultOwned(
  id: string,
  userId: string,
  findFn: FindVaultByIdFn,
  deleteById: DeleteVaultByIdFn,
): Promise<void> {
  await requireManageableVault(id, userId, findFn);
  await deleteById(id);
}

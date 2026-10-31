import { count, eq, or, isNull } from "drizzle-orm";
import { db } from "../../db";
import { vaults } from "../../db/schema";
import type {
  FindVaultByIdFn,
  InsertVaultFn,
  ListVisibleVaultsFn,
  UpdateVaultNameFn,
  VaultRow,
} from "../../handlers/vault-handlers";

/**
 * Vault rows, as the routes need them.
 *
 * Every statement about a vault lives here, so a route module is HTTP only and the
 * handlers keep taking their DB operations as injected functions.
 */

/** Resolve a vault by id, with its timestamps as `Date`. */
export const findVaultById: FindVaultByIdFn = async (id): Promise<VaultRow | undefined> => {
  const [row] = await db.select().from(vaults).where(eq(vaults.id, id)).limit(1);
  if (!row) return undefined;
  return { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) };
};

/**
 * Insert a vault for its owner, unless the owner's allowance is full.
 *
 * The count and the insert share one **immediate** transaction: taking the write
 * lock before the count means a second request queues on SQLite's busy timeout
 * and then sees the first row, instead of both reading a free slot and one
 * failing on the read-to-write upgrade. `undefined` means the allowance is full;
 * the handler turns that into `VAULT_LIMIT_REACHED`. An owner-less (legacy) vault
 * has no account to count against.
 */
export const insertVault: InsertVaultFn = async (data) =>
  db.transaction(
    (tx) => {
      if (data.ownerUserId !== null && data.maxVaults > 0) {
        const [owned] = tx
          .select({ owned: count() })
          .from(vaults)
          .where(eq(vaults.ownerUserId, data.ownerUserId))
          .all();
        if (owned.owned >= data.maxVaults) return undefined;
      }
      const [row] = tx
        .insert(vaults)
        .values({
          id: data.id,
          name: data.name,
          encryptionSalt: data.encryptionSalt,
          keyCheck: data.keyCheck,
          ownerUserId: data.ownerUserId,
        })
        .returning({ createdAt: vaults.createdAt })
        .all();
      return { createdAt: new Date(row.createdAt) };
    },
    { behavior: "immediate" },
  );

export const updateVaultName: UpdateVaultNameFn = async (id, name) => {
  const [row] = await db
    .update(vaults)
    .set({ name, updatedAt: new Date().toISOString() })
    .where(eq(vaults.id, id))
    .returning({ id: vaults.id, name: vaults.name });
  return row;
};

export const deleteVaultById = async (id: string): Promise<void> => {
  await db.delete(vaults).where(eq(vaults.id, id));
};

/**
 * The vaults a user may list: the ones it owns, plus owner-less legacy rows.
 *
 * This is `canAccessVault` (`lib/vault-access.ts`) written as SQL. The two have
 * to agree — `vault-access.e2e.test.ts` asserts that the ids a client can list
 * are exactly the ids its sync requests are accepted for.
 */
export const listVisibleVaults: ListVisibleVaultsFn = async (userId) => {
  const rows = await db
    .select({ id: vaults.id, name: vaults.name, createdAt: vaults.createdAt })
    .from(vaults)
    .where(visibleVaultsWhere(userId))
    .orderBy(vaults.createdAt);
  return rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt) }));
};

export function visibleVaultsWhere(userId: string) {
  return or(eq(vaults.ownerUserId, userId), isNull(vaults.ownerUserId));
}

/** Every vault id — the orphan sweep visits each vault's blob directory. */
export async function listVaultIds(): Promise<string[]> {
  const rows = await db.select({ id: vaults.id }).from(vaults);
  return rows.map((row) => row.id);
}

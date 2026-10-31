import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, vaults } from "../db/schema";
import type {
  FindUserByKeyFn,
  FindUserByIdFn,
  InsertUserFn,
  ListUsersFn,
  UpdateUserFn,
  DeleteUserFn,
  UserRow,
  UserStorageBytesFn,
  UserVaultCountFn,
} from "../handlers/users-handlers";
import { sumBytes } from "./blob-store";
import { NotFoundError } from "./errors";

function toRow(row: typeof users.$inferSelect): UserRow {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    storageBytesLimit: row.storageBytesLimit,
    retentionDays: row.retentionDays,
    maxFileBytes: row.maxFileBytes,
    maxVaults: row.maxVaults,
    expiresAt: row.expiresAt,
    disabled: row.disabled,
    createdAt: new Date(row.createdAt),
  };
}

/** Find a user by its raw user key (for userAuth middleware). */
export const findUserByKey: FindUserByKeyFn = async (key) => {
  const [row] = await db.select().from(users).where(eq(users.key, key)).limit(1);
  return row ? toRow(row) : undefined;
};

export const findUserById: FindUserByIdFn = async (id) => {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ? toRow(row) : undefined;
};

export const insertUser: InsertUserFn = async (data) => {
  const [row] = await db.insert(users).values(data).returning({ createdAt: users.createdAt });
  return { createdAt: new Date(row.createdAt) };
};

export const listUsers: ListUsersFn = async () => {
  const rows = await db.select().from(users).orderBy(users.createdAt);
  return rows.map(toRow);
};

export const updateUser: UpdateUserFn = async (id, patch) => {
  const values: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    values.name = patch.name;
  }
  if (patch.storageBytesLimit !== undefined) {
    values.storageBytesLimit = patch.storageBytesLimit;
  }
  if (patch.retentionDays !== undefined) {
    values.retentionDays = patch.retentionDays;
  }
  if (patch.maxFileBytes !== undefined) {
    values.maxFileBytes = patch.maxFileBytes;
  }
  if (patch.maxVaults !== undefined) {
    values.maxVaults = patch.maxVaults;
  }
  if (patch.expiresAt !== undefined) {
    values.expiresAt = patch.expiresAt;
  }
  if (patch.disabled !== undefined) {
    values.disabled = patch.disabled;
  }
  // No `.limit(1)`: SQLite only accepts LIMIT on UPDATE when it was built with
  // SQLITE_ENABLE_UPDATE_DELETE_LIMIT, which Bun's bundled SQLite is not — it is a
  // syntax error, and a 500 on every user edit. The id is the primary key, so the
  // statement cannot touch more than one row anyway.
  const [row] = await db.update(users).set(values).where(eq(users.id, id)).returning();
  if (!row) {
    throw new NotFoundError("User");
  }
  return toRow(row);
};

/**
 * Delete an account together with the vaults it owns, answering their ids.
 *
 * One transaction, and the vaults first: `file_versions.vault_id` cascades, so the
 * version rows go with them, and a crash between the two statements can never leave
 * an owner-less vault behind (the exact state this is meant to prevent). The blobs
 * are filesystem files the caller reclaims by the ids this returns — a vault row is
 * what names a blob directory, so deleting the rows first is safe.
 */
export const deleteUser: DeleteUserFn = async (id) => {
  return db.transaction(
    (tx) => {
      const owned = tx
        .select({ id: vaults.id })
        .from(vaults)
        .where(eq(vaults.ownerUserId, id))
        .all()
        .map((row) => row.id);
      tx.delete(vaults).where(eq(vaults.ownerUserId, id)).run();
      tx.delete(users).where(eq(users.id, id)).run();
      return owned;
    },
    { behavior: "immediate" },
  );
};

/** Approximate storage used across a user's vaults (sum of blob bytes). */
export const userStorageBytes: UserStorageBytesFn = async (userId) => {
  const userVaults = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(eq(vaults.ownerUserId, userId));
  let total = 0;
  for (const v of userVaults) {
    total += await sumBytes(v.id);
  }
  return total;
};

/** How many vaults the account owns right now, against its `maxVaults`. */
export const userVaultCount: UserVaultCountFn = async (userId) => {
  const rows = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(eq(vaults.ownerUserId, userId));
  return rows.length;
};

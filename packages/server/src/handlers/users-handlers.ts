import { DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_VAULTS } from "@courier/shared";
import type {
  CreateUserResponse,
  ListUsersResponse,
  RevealUserKeyResponse,
  UpdateUserRequest,
  UserSummary,
} from "@courier/shared";
import { generateUserKey } from "../lib/token";
import { maskUserKey } from "../lib/user-key";
import { NotFoundError, ValidationError } from "../lib/errors";

/**
 * A user row as seen by the handlers. Dates are already converted to `Date`
 * by the injected DB binding (matching the existing vault/auth handler style).
 */
export interface UserRow {
  id: string;
  name: string;
  key: string;
  storageBytesLimit: number | null;
  retentionDays: number | null;
  /** Largest plaintext file this key's clients may sync, in bytes (`0` = unlimited). */
  maxFileBytes: number;
  /** How many vaults this key may own (`0` = unlimited). */
  maxVaults: number;
  expiresAt: string | null;
  /** The host has disabled the account: it authenticates nothing until re-enabled. */
  disabled: boolean;
  createdAt: Date;
}

/** Build the public summary (masks the key) for a user row. */
export function toUserSummary(u: UserRow, usedBytes?: number, vaultsCount?: number): UserSummary {
  return {
    id: u.id,
    name: u.name,
    storageBytesLimit: u.storageBytesLimit,
    maskedKey: maskUserKey(u.key),
    retentionDays: u.retentionDays,
    maxFileBytes: u.maxFileBytes,
    maxVaults: u.maxVaults,
    expiresAt: u.expiresAt,
    disabled: u.disabled,
    createdAt: u.createdAt.toISOString(),
    ...(usedBytes !== undefined ? { usedBytes } : {}),
    ...(vaultsCount !== undefined ? { vaultsCount } : {}),
  };
}

// ── Action types (db operations injected by the caller) ──

/** Find a user by its raw key (for userAuth middleware). */
export type FindUserByKeyFn = (key: string) => Promise<UserRow | undefined>;

export type FindUserByIdFn = (id: string) => Promise<UserRow | undefined>;

export type InsertUserFn = (data: {
  id: string;
  name: string;
  key: string;
  storageBytesLimit: number | null;
  retentionDays: number | null;
  maxFileBytes: number;
  maxVaults: number;
  expiresAt: string | null;
  disabled: boolean;
}) => Promise<{ createdAt: Date }>;

export type ListUsersFn = () => Promise<UserRow[]>;

export type UpdateUserFn = (id: string, patch: UpdateUserRequest) => Promise<UserRow>;

/**
 * Delete an account **and the vaults it owns**, answering the ids of the vaults that
 * went with it.
 *
 * The vault ids are the caller's receipt: the rows are gone, but the encrypted blobs
 * live on the filesystem, and only the caller can reclaim them. An account whose
 * vaults outlived it would be owner-less storage nobody can reach, charged to nobody.
 */
export type DeleteUserFn = (id: string) => Promise<string[]>;

/** Compute the approximate storage used across a user's vaults (bytes). */
export type UserStorageBytesFn = (userId: string) => Promise<number>;

/** Count the vaults a user owns, for the `maxVaults` allowance. */
export type UserVaultCountFn = (userId: string) => Promise<number>;

// ── Create User ──

export interface CreateUserInput {
  name: string;
  storageBytesLimit?: number | null;
  retentionDays?: number | null;
  maxFileBytes?: number;
  maxVaults?: number;
  expiresAt?: string | null;
  disabled?: boolean;
}

/**
 * Whether an ISO 8601 expiry names an instant still ahead of `now`.
 *
 * One rule for create and edit, and deliberately strict: an unparseable value is
 * **not** in the future (the auth path already treats one as expired), and the
 * boundary instant itself counts as expired (`isExpiredAt` uses `<=`).
 */
function isFutureInstant(value: string, now: Date): boolean {
  const at = new Date(value);
  return !Number.isNaN(at.getTime()) && at.getTime() > now.getTime();
}

export async function createUser(
  input: CreateUserInput,
  insertUser: InsertUserFn,
  now = new Date(),
): Promise<CreateUserResponse> {
  const id = crypto.randomUUID();
  const key = generateUserKey();
  const maxFileBytes = input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxVaults = input.maxVaults ?? DEFAULT_MAX_VAULTS;
  const disabled = input.disabled ?? false;
  // The same validity rule an edit follows: a key that is born expired is not a
  // deliberate state (disabling is), so it is refused before a row exists.
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && !isFutureInstant(expiresAt, now)) {
    throw new ValidationError("expiresAt must be in the future", [
      { field: "expiresAt", message: "expiresAt must be in the future" },
    ]);
  }
  const { createdAt } = await insertUser({
    id,
    name: input.name,
    key,
    storageBytesLimit: input.storageBytesLimit ?? null,
    retentionDays: input.retentionDays ?? null,
    maxFileBytes,
    maxVaults,
    expiresAt,
    disabled,
  });
  return {
    id,
    name: input.name,
    key,
    storageBytesLimit: input.storageBytesLimit ?? null,
    maskedKey: maskUserKey(key),
    retentionDays: input.retentionDays ?? null,
    maxFileBytes,
    maxVaults,
    expiresAt,
    disabled,
    createdAt: createdAt.toISOString(),
  };
}

// ── List Users ──

export async function listUsers(
  listFn: ListUsersFn,
  usedBytes?: UserStorageBytesFn,
  vaultCount?: UserVaultCountFn,
): Promise<ListUsersResponse> {
  const rows = await listFn();
  const users = await Promise.all(
    rows.map(async (u) => {
      const bytes = usedBytes ? await usedBytes(u.id) : undefined;
      const vaults = vaultCount ? await vaultCount(u.id) : undefined;
      return toUserSummary(u, bytes, vaults);
    }),
  );
  return { users };
}

// ── Update User ──

/**
 * Everything a user edit has to check before it is written.
 *
 * The three limits the server enforces are also the three an edit can put the
 * account in an impossible state with, so the same answer decides both the API and
 * the admin form: a cap below what is already stored, an allowance below the
 * vaults that already exist, and a validity that has already run out.
 */
export interface UpdateUserDeps {
  find: FindUserByIdFn;
  update: UpdateUserFn;
  /** The account's current storage usage (bytes), walked only when the cap changes. */
  usedBytes: UserStorageBytesFn;
  /** How many vaults the account owns, counted only when the allowance changes. */
  vaultCount: UserVaultCountFn;
  /** The clock the validity rule reads. */
  now?: () => Date;
}

/** One refusal: the field it is about and the sentence a host is shown. */
export interface UpdateRefusal {
  field: "storageBytesLimit" | "maxVaults" | "expiresAt";
  message: string;
}

/**
 * Why `patch` must be refused, or null when it is allowed.
 *
 * Pure, so the rule is unit-tested without a database — and so the same function can
 * answer "would this be refused?" before anything is written:
 *
 * - a storage cap **below current usage** would silently turn the account read-only
 *   for new content (deletes and renames still work, so the state is not even
 *   obviously broken); the host has to free space first, which is a decision they
 *   can only make knowingly;
 * - a vault allowance **below the vaults that exist** can never be reached again
 *   (vaults are only deleted by hand), so it is a number that no longer describes
 *   the account;
 * - an expiry **in the past** would make the key dead on arrival, which is what
 *   disabling is for — and disabling is reversible.
 *
 * `0` keeps its "unlimited" meaning for both caps, and `null` clears a cap, so
 * neither is ever a refusal.
 */
export function updateRefusal(
  patch: UpdateUserRequest,
  current: { usedBytes: number; vaults: number },
  now: Date,
): UpdateRefusal | null {
  const storage = patch.storageBytesLimit;
  if (storage !== undefined && storage !== null && storage < current.usedBytes) {
    return {
      field: "storageBytesLimit",
      message:
        `storageBytesLimit (${storage} bytes) is below the account's current usage ` +
        `(${current.usedBytes} bytes); free space first, or raise the cap`,
    };
  }

  const vaults = patch.maxVaults;
  if (vaults !== undefined && vaults > 0 && vaults < current.vaults) {
    return {
      field: "maxVaults",
      message:
        `maxVaults (${vaults}) is below the ${current.vaults} vaults the account already ` +
        `owns; delete a vault first, or raise the allowance`,
    };
  }

  const expires = patch.expiresAt;
  if (expires !== undefined && expires !== null && !isFutureInstant(expires, now)) {
    return {
      field: "expiresAt",
      message: "expiresAt must be in the future; disable the key instead of expiring it",
    };
  }

  return null;
}

export async function updateUser(
  id: string,
  patch: UpdateUserRequest,
  deps: UpdateUserDeps,
): Promise<UserSummary> {
  if (!(await deps.find(id))) {
    throw new NotFoundError("User");
  }

  // Only walk/count for the fields the patch actually touches: a rename must not pay
  // for a walk over every blob directory the account owns.
  const usedBytes =
    patch.storageBytesLimit === undefined || patch.storageBytesLimit === null
      ? 0
      : await deps.usedBytes(id);
  const vaults =
    patch.maxVaults === undefined || patch.maxVaults === 0 ? 0 : await deps.vaultCount(id);

  const refusal = updateRefusal(patch, { usedBytes, vaults }, (deps.now ?? (() => new Date()))());
  if (refusal) {
    throw new ValidationError(refusal.message, [refusal]);
  }

  return toUserSummary(await deps.update(id, patch));
}

// ── Reveal one key ──

/**
 * Return the full key of one account. The list only carries the mask, so this is
 * the one explicit way a host can copy a key it did not save at creation.
 */
export async function revealUserKey(
  id: string,
  findFn: FindUserByIdFn,
): Promise<RevealUserKeyResponse> {
  const user = await findFn(id);
  if (!user) {
    throw new NotFoundError("User");
  }
  return { key: user.key };
}

// ── Delete User (revoke) ──

/**
 * Delete an account and everything it owns, answering the vault ids that went with it.
 *
 * Deleting the key alone would leave its vaults behind: `vaults.owner_user_id` is
 * `ON DELETE SET NULL`, so they would become owner-less rows that **every** other
 * account may list, push to and delete (`lib/vault-access.ts`), while their blobs are
 * charged to nobody and never reclaimed. "Delete this key" therefore means "delete this
 * account", and the caller reclaims the blobs the returned ids name.
 */
export async function deleteUser(
  id: string,
  findFn: FindUserByIdFn,
  deleteFn: DeleteUserFn,
): Promise<string[]> {
  if (!(await findFn(id))) {
    throw new NotFoundError("User");
  }
  return await deleteFn(id);
}

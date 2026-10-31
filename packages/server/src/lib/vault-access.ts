/**
 * Who may use a vault: the one rule, in one place.
 *
 * Kept free of DB imports so both the middlewares and the handlers can ask it,
 * and so it unit-tests with a plain row (the `handlers/*` test style). The SQL
 * half of the same rule — the `WHERE` a vault listing uses — lives in
 * `db/repositories/vaults.ts`; `vault-access.e2e.test.ts` pins the two together
 * by asserting that the ids a client can list are exactly the ids it can sync.
 */

/**
 * Whether `userId` may use `vault`.
 *
 * A vault belongs to the user it was created by. A vault with **no owner** is a
 * legacy row from before the multi-user model: every authenticated user may use
 * it, which is the same answer the management routes give (`PATCH`/`DELETE
 * /api/vaults/:id`).
 */
export function canAccessVault(vault: { ownerUserId: string | null }, userId: string): boolean {
  return vault.ownerUserId === userId || vault.ownerUserId == null;
}

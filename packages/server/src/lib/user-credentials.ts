import { UnauthorizedError } from "./errors";
import { assertUserActive } from "./quota";
import type { FindUserByKeyFn, UserRow } from "../handlers/users-handlers";

/**
 * The one place that turns a credential into an authenticated user.
 *
 * Three callers need the same `ck_` check — the HTTP middlewares (`userAuth`,
 * `syncAuth`) and the WebSocket `subscribe` handler — and a rule that decides who
 * may sync must not exist in three versions. Kept free of DB and Hono imports so
 * it unit-tests with a plain `findUserByKey` mock, like `lib/quota.ts`.
 */

/**
 * The token inside an `Authorization: Bearer <token>` header, or a throw.
 *
 * `prefix` is the credential family the caller accepts (`ck_` for user keys,
 * `ak_` for host keys), so "an admin key may not sync" and "a user key may not
 * manage users" are the same check with different arguments.
 */
export function bearerToken(header: string | null | undefined, prefix: string): string {
  if (!header?.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or invalid token");
  }
  const token = header.slice(7);
  if (!token.startsWith(prefix)) {
    throw new UnauthorizedError("Invalid token format");
  }
  return token;
}

/**
 * Validate a raw `ck_` user key and resolve the account it belongs to.
 *
 * The value form (rather than the header form) is what the WebSocket
 * `subscribe` message carries: it sends the key itself, with no `Bearer `
 * prefix. A key that is expired — or whose owner was deleted — is refused here,
 * so no route has to remember to check it.
 */
export async function authenticateUserKey(
  key: string,
  findUserByKey: FindUserByKeyFn,
): Promise<UserRow> {
  if (!key.startsWith("ck_")) {
    throw new UnauthorizedError("Invalid token format");
  }
  const user = await findUserByKey(key);
  if (!user) {
    throw new UnauthorizedError("Invalid or expired user key");
  }
  assertUserActive(user);
  return user;
}

/** The `Authorization: Bearer` form of {@link authenticateUserKey}. */
export async function authenticateUserHeader(
  header: string | null | undefined,
  findUserByKey: FindUserByKeyFn,
): Promise<UserRow> {
  return await authenticateUserKey(bearerToken(header, "ck_"), findUserByKey);
}

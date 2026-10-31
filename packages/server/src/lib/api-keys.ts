import { eq } from "drizzle-orm";
import { db } from "../db";
import { apiKeys } from "../db/schema";
import type { FindApiKeyFn } from "../handlers/auth-handlers";

/**
 * Shared DB binding — used by middleware (api-key-auth) and the WS handler.
 * Looks up the raw API key directly (no hashing), returning the scope list and
 * expiry the authorization decision is made from.
 */
export const findByKey: FindApiKeyFn = async (key) => {
  const [row] = await db
    .select({ id: apiKeys.id, scopes: apiKeys.scopes, expiresAt: apiKeys.expiresAt })
    .from(apiKeys)
    .where(eq(apiKeys.key, key))
    .limit(1);
  return row;
};

import { eq } from "drizzle-orm";
import { db } from "../db";
import { apiKeys } from "../db/schema";
import type { ApikeyCliActions } from "./apikey";

/**
 * Real action implementations for the apikey CLI commands (Drizzle).
 * Kept separate from the command logic so tests never open the database.
 */
export const apikeyCliActions: ApikeyCliActions = {
  insertApiKey: async (data) => {
    const [row] = await db.insert(apiKeys).values(data).returning({ createdAt: apiKeys.createdAt });
    return { createdAt: new Date(row.createdAt) };
  },

  listAll: async () => {
    const rows = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        key: apiKeys.key,
        scopes: apiKeys.scopes,
        expiresAt: apiKeys.expiresAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .orderBy(apiKeys.createdAt);
    return rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt) }));
  },

  deleteById: async (id) => {
    await db.delete(apiKeys).where(eq(apiKeys.id, id));
  },

  findApiKeyById: async (id) => {
    const [row] = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(eq(apiKeys.id, id))
      .limit(1);
    return row;
  },
};

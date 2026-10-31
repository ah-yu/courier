import { eq } from "drizzle-orm";
import { db } from "../db";
import { fileVersions } from "../db/schema";

/**
 * All content hashes still referenced by a vault's version rows.
 *
 * One implementation, two callers: retention pruning (which reclaims what its own
 * pass orphaned) and clearing the recycle bin (which reclaims what the rows it just
 * removed orphaned).
 */
export async function getReferencedContentHashes(vaultId: string): Promise<Set<string>> {
  const rows = await db
    .select({ contentHash: fileVersions.contentHash })
    .from(fileVersions)
    .where(eq(fileVersions.vaultId, vaultId));
  return new Set(rows.map((r) => r.contentHash));
}

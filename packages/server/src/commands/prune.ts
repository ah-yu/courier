import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { users, vaults, fileVersions } from "../db/schema";
import { retentionCutoff } from "../lib/quota";
import { selectRowsToPrune } from "../lib/prune";
import { deleteBlob, listBlobHashes } from "../lib/blob-store";
import { getReferencedContentHashes } from "../lib/blob-references";
import { info } from "../lib/output";
import { logger } from "../lib/log";

/**
 * Retention pruning pass. For every user with a retention window, removes
 * version-chain rows older than the window — except each file's latest
 * version — then deletes blobs that are no longer referenced.
 *
 * Exposed as a single runnable unit for tests/dev; `startPruneLoop` schedules
 * it on an interval (see config.PRUNE_INTERVAL_MS).
 */
export async function runPruneOnce(
  now = new Date(),
): Promise<{ prunedRows: number; prunedBlobs: number }> {
  const retentionUsers = await db
    .select({ id: users.id, retentionDays: users.retentionDays })
    .from(users)
    .where(isNotNull(users.retentionDays));

  let prunedRows = 0;
  let prunedBlobs = 0;

  for (const u of retentionUsers) {
    const cutoff = retentionCutoff(u.retentionDays, now);
    if (!cutoff) continue;

    const userVaults = await db
      .select({ id: vaults.id })
      .from(vaults)
      .where(eq(vaults.ownerUserId, u.id));

    for (const vault of userVaults) {
      const fileIds = await db
        .selectDistinct({ fileId: fileVersions.fileId })
        .from(fileVersions)
        .where(eq(fileVersions.vaultId, vault.id));

      for (const { fileId } of fileIds) {
        const chain = await db
          .select({
            fileId: fileVersions.fileId,
            versionId: fileVersions.versionId,
            createdAt: fileVersions.createdAt,
          })
          .from(fileVersions)
          .where(and(eq(fileVersions.vaultId, vault.id), eq(fileVersions.fileId, fileId)))
          // Same order as the sync API's chain and the conditional insert's head
          // (`created_at`, then `rowid`): "the latest version is always kept" has to
          // name the same row they do.
          .orderBy(asc(fileVersions.createdAt), asc(sql`rowid`));

        const toPrune = selectRowsToPrune(chain, cutoff);
        if (toPrune.length === 0) continue;

        const versionIds = toPrune.map((r) => r.versionId);
        for (const versionId of versionIds) {
          await db
            .delete(fileVersions)
            .where(and(eq(fileVersions.vaultId, vault.id), eq(fileVersions.versionId, versionId)));
        }
        prunedRows += versionIds.length;
      }

      // Reclaim blobs that are no longer referenced by any version row.
      const referenced = await getReferencedContentHashes(vault.id);
      const deletedBlobs = await deleteUnreferencedBlobs(vault.id, referenced);
      prunedBlobs += deletedBlobs;
    }
  }

  // Deleting a blob row frees its bytes as soon as it was the last row pointing into its
  // batch file — the store unlinks that file in the same step — so this pass has nothing
  // left to rewrite.

  if (prunedRows > 0 || prunedBlobs > 0) {
    info(`Pruned ${prunedRows} version rows and ${prunedBlobs} blobs`);
  }
  return { prunedRows, prunedBlobs };
}

async function deleteUnreferencedBlobs(vaultId: string, referenced: Set<string>): Promise<number> {
  const hashes = await listBlobHashes(vaultId);
  let deleted = 0;
  for (const hash of hashes) {
    if (!referenced.has(hash)) {
      await deleteBlob(vaultId, hash);
      deleted++;
    }
  }
  return deleted;
}

/** Schedule periodic pruning. Returns a stop function. */
export function startPruneLoop(intervalMs: number): () => void {
  // `PRUNE_INTERVAL_MS=0` is the documented way to turn retention pruning off.
  // Handing 0 to setInterval would not disable it — it would run the pass in a
  // tight loop, which is the opposite of what the setting is for.
  if (intervalMs <= 0) {
    return () => {};
  }
  const timer = setInterval(() => {
    void runPruneOnce().catch((err: unknown) => {
      logger.error(`Prune pass failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

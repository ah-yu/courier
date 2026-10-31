import type { BlobStat } from "./blob-store";

/**
 * Everything the orphan sweep needs, injected so the rule is testable without a
 * database or a blob directory.
 */
export interface OrphanBlobSweepDeps {
  listVaultIds(): Promise<string[]>;
  listBlobHashes(vaultId: string): Promise<string[]>;
  /** Content hashes some version row still references — the blobs that must stay. */
  listReferencedHashes(vaultId: string): Promise<readonly string[]>;
  statBlob(vaultId: string, contentHash: string): Promise<BlobStat | undefined>;
  deleteBlob(vaultId: string, contentHash: string): Promise<void>;
}

export interface OrphanBlobSweepOptions {
  /** Only blobs at least this old are candidates, so a push mid-write is never swept. */
  minAgeMs: number;
  now?: number;
}

/**
 * Delete blobs no version row references, once they are old enough.
 *
 * A push writes the blob **before** the conditional insert: when the insert is refused
 * (`stale_base`, `content_missing`, an error), the bytes stay on disk with no row
 * pointing at them. Retention pruning used to be the only collector, and only for users
 * who had a retention window. This sweep runs for every vault: a blob younger than
 * `minAgeMs` is left alone (a push that is still in flight owns it), and one that is
 * older and unreferenced cannot be reachable — the row would have been inserted before
 * the process could observe the age.
 *
 * Per-vault and per-blob failures are skipped rather than aborting the sweep: one
 * unreadable directory must not keep every other orphan alive.
 */
export async function sweepOrphanBlobs(
  deps: OrphanBlobSweepDeps,
  options: OrphanBlobSweepOptions,
): Promise<number> {
  const now = options.now ?? Date.now();
  const cutoff = now - options.minAgeMs;
  let removed = 0;

  const vaultIds = await deps.listVaultIds().catch(() => [] as string[]);
  for (const vaultId of vaultIds) {
    // A failed reference read must skip the vault, never treat it as "nothing is
    // referenced": this is a delete loop, and an empty set would unlink live content.
    let referenced: Set<string>;
    try {
      referenced = new Set(await deps.listReferencedHashes(vaultId));
    } catch {
      continue;
    }
    const hashes = await deps.listBlobHashes(vaultId).catch(() => [] as string[]);
    for (const contentHash of hashes) {
      if (referenced.has(contentHash)) continue;
      const stat = await deps.statBlob(vaultId, contentHash).catch(() => undefined);
      // Strictly older than the TTL: a blob exactly at the cutoff may still belong to a
      // push between its write and its row.
      if (stat === undefined || stat.mtimeMs >= cutoff) continue;
      try {
        await deps.deleteBlob(vaultId, contentHash);
        removed++;
      } catch {
        // A concurrent push may have replaced it; the next sweep sees the result.
      }
    }
  }
  return removed;
}

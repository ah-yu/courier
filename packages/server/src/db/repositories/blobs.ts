import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { blobs } from "../../db/schema";

/**
 * The blob index: one row per `(vault, plaintext hash)` naming a byte range in one batch
 * file.
 *
 * The store (`lib/blob-store.ts`) owns the bytes; this module owns every statement about
 * the index. The rules it must not lose:
 *
 * - a blob row is inserted **after** its batch file was flushed and renamed, so "the row
 *   exists" means "the bytes are on disk";
 * - a file is unlinked only when no row names it any more, which is why a row is
 *   authoritative about where its bytes are (the read path does not have to `stat`).
 */

export interface BlobRow {
  contentHash: string;
  /** File name inside the vault's blob directory. */
  file: string;
  offset: number;
  length: number;
  plaintextSize: number;
  chunkCount: number;
}

export function findBlob(vaultId: string, contentHash: string): BlobRow | undefined {
  return db
    .select({
      contentHash: blobs.contentHash,
      file: blobs.file,
      offset: blobs.offset,
      length: blobs.length,
      plaintextSize: blobs.plaintextSize,
      chunkCount: blobs.chunkCount,
    })
    .from(blobs)
    .where(and(eq(blobs.vaultId, vaultId), eq(blobs.contentHash, contentHash)))
    .get();
}

export function hasBlobRow(vaultId: string, contentHash: string): boolean {
  return (
    db
      .select({ contentHash: blobs.contentHash })
      .from(blobs)
      .where(and(eq(blobs.vaultId, vaultId), eq(blobs.contentHash, contentHash)))
      .get() !== undefined
  );
}

/**
 * Index the blobs a batch file now holds, in one transaction.
 *
 * The conflict clause is an **update**: a re-push of content whose file was lost (a
 * removed or externally truncated batch file) has to be able to repoint the row at the
 * copy it just wrote. Inserting nothing — the previous behaviour — left that hash
 * unservable for the life of the vault, because every later push found the row present.
 */
export function insertBlobRows(vaultId: string, rows: readonly BlobRow[]): void {
  if (rows.length === 0) return;
  db.transaction((tx) => {
    for (const row of rows) {
      tx.insert(blobs)
        .values({ vaultId, ...row })
        .onConflictDoUpdate({
          target: [blobs.vaultId, blobs.contentHash],
          set: {
            file: row.file,
            offset: row.offset,
            length: row.length,
            plaintextSize: row.plaintextSize,
            chunkCount: row.chunkCount,
          },
        })
        .run();
    }
  });
}

export function sumBlobBytes(vaultId: string): number {
  const row = db
    .select({ total: sql<number>`coalesce(sum(${blobs.length}), 0)` })
    .from(blobs)
    .where(eq(blobs.vaultId, vaultId))
    .get();
  return row?.total ?? 0;
}

export async function listBlobHashes(vaultId: string): Promise<string[]> {
  const rows = await db
    .select({ contentHash: blobs.contentHash })
    .from(blobs)
    .where(eq(blobs.vaultId, vaultId));
  return rows.map((row) => row.contentHash);
}

/** Every file name a vault's rows still name, so a reclaim can unlink the orphans. */
export async function listFiles(vaultId: string): Promise<string[]> {
  const rows = await db
    .select({ file: blobs.file })
    .from(blobs)
    .where(eq(blobs.vaultId, vaultId))
    .groupBy(blobs.file)
    .orderBy(asc(blobs.file));
  return rows.map((row) => row.file);
}

/** Does any row (of any vault) name this file? */
export function hasFileRows(file: string): boolean {
  return (
    db.select({ contentHash: blobs.contentHash }).from(blobs).where(eq(blobs.file, file)).get() !==
    undefined
  );
}

/**
 * Delete one blob row, answering the file it leaves unreferenced (or `undefined` when
 * other rows still point into it).
 *
 * The count runs in the same transaction as the delete: a file unlinked while another
 * row still names it would turn a live blob into a `content_missing`.
 */
export function deleteBlobRow(vaultId: string, contentHash: string): string | undefined {
  return db.transaction((tx) => {
    const row = tx
      .select({ file: blobs.file })
      .from(blobs)
      .where(and(eq(blobs.vaultId, vaultId), eq(blobs.contentHash, contentHash)))
      .get();
    if (row === undefined) return undefined;
    tx.delete(blobs)
      .where(and(eq(blobs.vaultId, vaultId), eq(blobs.contentHash, contentHash)))
      .run();
    const remaining = tx
      .select({ contentHash: blobs.contentHash })
      .from(blobs)
      .where(eq(blobs.file, row.file))
      .get();
    return remaining === undefined ? row.file : undefined;
  });
}

export function deleteVaultRows(vaultId: string): void {
  db.delete(blobs).where(eq(blobs.vaultId, vaultId)).run();
}

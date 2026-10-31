import crypto from "crypto";
import fs from "fs/promises";
import type { FileHandle } from "fs/promises";
import path from "path";
import {
  BLOB_HEADER_BYTES,
  CHUNK_PLAINTEXT_BYTES,
  MAX_CHUNKS,
  chunkCountFor,
  encodeBlobHeader,
  parseBlobHeader,
  storedChunkBytes,
  type BlobHeader,
} from "@courier/shared";
import { config } from "../config";
import * as blobsRepo from "../db/repositories/blobs";
import type { ByteRange } from "./byte-range";
import { NotFoundError } from "./errors";

/** Base directory for blob storage. Override with BLOB_STORE_DIR env var. */
const BASE_DIR = config.BLOB_STORE_DIR;

/**
 * One push batch's file, while it is being written.
 *
 * The batch is the unit of durability: its payloads go into one file, one `fsync` makes
 * them permanent, and only then do the rows that name them commit. Nothing else ever
 * writes this file, which is what removes the recovery rule a segment needed (there is no
 * committed length to truncate to) and the compaction step it needed (there is no dead
 * byte to rewrite: a file is unlinked when its last row goes).
 */
interface Batch {
  /** Final name, `<uuid>.blob`. The bytes are written to `<file>.tmp` until the flush. */
  file: string;
  handle: FileHandle;
  /** Bytes written so far, i.e. the offset the next blob lands at. */
  bytes: number;
}

const batches = new Map<string, Batch>();
/** Rows whose bytes are in the batch in progress, by vault. */
const pendingBlobs = new Map<string, blobsRepo.BlobRow[]>();
/** Per-vault append serialization: one batch, in call order. */
const appendChains = new Map<string, Promise<void>>();

/**
 * Rotate a batch file once it holds this much.
 *
 * A request normally flushes its own batch, so this only fires for a single request that
 * carries more than this (the wire limit is larger) and for a chunked assembly of a big
 * file: without it one file could grow to the size of a whole vault.
 */
const BATCH_MAX_BYTES = 128 * 1024 * 1024;

/**
 * Run `run` with this vault's append lock held.
 *
 * Appends and the flush must not interleave: the flush renames the file and indexes the
 * rows, and an append landing after that would write into a file no row names. Nothing
 * here waits on a path (the engine's rule), only on the previous store operation for the
 * same vault.
 */
async function withVaultLock<T>(vaultId: string, run: () => Promise<T>): Promise<T> {
  const previous = appendChains.get(vaultId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => gate);
  appendChains.set(vaultId, chained);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (appendChains.get(vaultId) === chained) appendChains.delete(vaultId);
  }
}

/** The vault's own directory inside the store, guarded against traversal. */
function vaultDir(vaultId: string): string {
  const store = path.resolve(BASE_DIR);
  const resolved = path.resolve(store, vaultId);
  if (!resolved.startsWith(store + path.sep)) {
    throw new NotFoundError("Blob");
  }
  return resolved;
}

/** Where one batch file lives, scoped to the vault's own directory. */
function batchPath(vaultId: string, file: string): string {
  const root = vaultDir(vaultId);
  const resolved = path.resolve(root, file);
  if (!resolved.startsWith(root + path.sep)) {
    throw new NotFoundError("Blob");
  }
  return resolved;
}

/**
 * Where a chunked upload stages its parts, inside the vault's own directory.
 *
 * `sumBytes` counts these (they are disk the account is using), `sweepUploads` reclaims
 * one nobody finished, and assembly removes it once the blob is published.
 */
function uploadDir(vaultId: string, contentHash: string): string {
  return path.join(vaultDir(vaultId), "uploads", contentHash);
}

// ── Batch files ──

/** `FileHandle.sync()` is `fsync`; the helper exists to say so at each call site. */
async function syncFile(handle: FileHandle): Promise<void> {
  await handle.sync();
}

/**
 * Flush a directory entry, where the platform can.
 *
 * `fsync` on a batch file persists its **bytes**, not the name that makes them reachable.
 * Without a directory flush a crash right after the rename can lose the name while the
 * rows that point into it survive — so every blob in that file would read as absent.
 * Windows cannot open a directory for this and some filesystems do not implement it; both
 * are best effort, because the alternative is refusing to store anything.
 */
async function syncDirectory(dirPath: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(dirPath, "r");
    await handle.sync();
  } catch {
    // `EISDIR`/`EPERM` on Windows, `ENOTSUP` elsewhere.
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Open the vault's batch file, creating it on the first write of a batch. */
async function openBatch(vaultId: string): Promise<Batch> {
  const cached = batches.get(vaultId);
  if (cached) return cached;
  await fs.mkdir(vaultDir(vaultId), { recursive: true });
  const file = `${crypto.randomUUID()}.blob`;
  const handle = await fs.open(batchPath(vaultId, `${file}.tmp`), "w");
  const batch: Batch = { file, handle, bytes: 0 };
  batches.set(vaultId, batch);
  return batch;
}

/** Throw the batch away without publishing it (a write failed, or the process is done). */
async function discardBatch(vaultId: string): Promise<void> {
  const batch = batches.get(vaultId);
  batches.delete(vaultId);
  pendingBlobs.delete(vaultId);
  if (batch === undefined) return;
  await batch.handle.close().catch(() => {});
  await fs.rm(batchPath(vaultId, `${batch.file}.tmp`), { force: true }).catch(() => {});
}

/**
 * Publish the batch: flush it, rename it into place, then index the rows that name it.
 *
 * The order is the durability contract — bytes first, rows second — and the rename is a
 * separate step from the flush because a `.tmp` file that never got renamed is simply not
 * referenced by anything: a crash there leaves garbage the unreferenced-file sweep
 * collects, never a row pointing at a half-written file.
 */
/**
 * Vaults whose last publish failed, with the blobs it lost.
 *
 * A publish writes one file for however many blobs the vault has pending — those of the
 * request that flushes, and those another request appended while it was writing. When it
 * fails, every one of those rows is gone, so **every** request that appended into it has
 * to fail rather than commit a version whose content no peer can fetch. The request whose
 * flush failed already failed; this latch fails the next flush (the other request's, or
 * this one's retry) once.
 */
const publishFailures = new Map<string, string>();

/** Fail the next flush for this vault: its previous batch could not be published. */
function latchPublishFailure(vaultId: string, reason: string): void {
  publishFailures.set(vaultId, reason);
}

async function publishBatchLocked(vaultId: string): Promise<void> {
  const batch = batches.get(vaultId);
  if (batch === undefined) return;
  const rows = pendingBlobs.get(vaultId) ?? [];

  const tmpPath = batchPath(vaultId, `${batch.file}.tmp`);
  const finalPath = batchPath(vaultId, batch.file);
  let renamed = false;
  try {
    await syncFile(batch.handle);
    await batch.handle.close();
    await fs.rename(tmpPath, finalPath);
    renamed = true;
    await syncDirectory(vaultDir(vaultId));
    // The rows last: until this commits, nothing names the bytes, so a failure here leaves
    // an unreferenced file the sweep reclaims rather than a chain pointing at a hole.
    blobsRepo.insertBlobRows(vaultId, rows);
  } catch (err) {
    await batch.handle.close().catch(() => {});
    await fs.rm(renamed ? finalPath : tmpPath, { force: true }).catch(() => {});
    batches.delete(vaultId);
    pendingBlobs.delete(vaultId);
    latchPublishFailure(
      vaultId,
      `the blob batch for this vault could not be published: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
  batches.delete(vaultId);
  pendingBlobs.delete(vaultId);
}

/**
 * Append one framed record to the vault's batch and queue its row.
 *
 * A failed write rolls the file back to where this record started, so the batch's earlier
 * blobs stay intact and only this one answers for the failure; the bytes past that point
 * are not part of the file's published content anyway.
 */
async function appendLocked(
  vaultId: string,
  contentHash: string,
  parts: readonly Uint8Array[],
  meta: { plaintextSize: number; chunkCount: number },
): Promise<void> {
  const batch = await openBatch(vaultId);
  const start = batch.bytes;
  let written = 0;
  try {
    for (const part of parts) {
      await batch.handle.write(part, 0, part.byteLength, start + written);
      written += part.byteLength;
    }
  } catch (err) {
    await batch.handle.truncate(start).catch(() => {});
    batch.bytes = start;
    throw err;
  }
  const rows = pendingBlobs.get(vaultId) ?? [];
  rows.push({
    contentHash,
    file: batch.file,
    offset: start,
    length: written,
    plaintextSize: meta.plaintextSize,
    chunkCount: meta.chunkCount,
  });
  pendingBlobs.set(vaultId, rows);
  batch.bytes = start + written;
  if (batch.bytes >= BATCH_MAX_BYTES) await publishBatchLocked(vaultId);
}

/**
 * Flush whatever this vault has written but not yet indexed.
 *
 * Pushes call this once per batch, before their version rows commit; that is what makes
 * "the row is committed" mean "the bytes survived a crash".
 */
export async function flushBlobWrites(vaultId: string): Promise<void> {
  await withVaultLock(vaultId, async () => {
    const failure = publishFailures.get(vaultId);
    if (failure !== undefined) {
      // Consumed once: the caller's files fail, the engine retries them, and the retry
      // appends their bytes again into a fresh batch.
      publishFailures.delete(vaultId);
      throw new Error(failure);
    }
    await publishBatchLocked(vaultId);
  });
}

/**
 * Does this vault hold a blob for this hash?
 *
 * Pending appends count: a `rename` in the same batch as the `create` that carried its
 * bytes must find them, exactly as it did when each blob was its own file. A committed
 * blob is checked against the disk, not just the index: the file has to be long enough for
 * the range **and** carry a readable frame, so a lost, truncated or corrupt file answers
 * absent and a re-push can replace it — a chain that was accepted against unreadable bytes
 * could never be fetched again.
 */
export async function hasBlob(vaultId: string, contentHash: string): Promise<boolean> {
  if ((pendingBlobs.get(vaultId) ?? []).some((row) => row.contentHash === contentHash)) return true;
  const row = blobsRepo.findBlob(vaultId, contentHash);
  if (row === undefined) return false;
  const filePath = batchPath(vaultId, row.file);
  const handle = await fs.open(filePath, "r").catch(() => null);
  if (handle === null) return false;
  try {
    const stat = await handle.stat();
    if (stat.size < row.offset + row.length) return false;
    // The frame has to parse: a same-length file full of zeros served as "the store holds
    // it" is exactly the hit the content route then cannot serve.
    const head = new Uint8Array(BLOB_HEADER_BYTES);
    const { bytesRead } = await handle.read(head, 0, BLOB_HEADER_BYTES, row.offset);
    return bytesRead === BLOB_HEADER_BYTES && parseBlobHeader(head) !== null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Write encrypted content to the store.
 *
 * A blob the vault already holds is not rewritten: the store is content-addressed by the
 * *plaintext* hash, so a second push of the same bytes adds nothing. The write itself
 * appends to the vault's batch; the batch's {@link flushBlobWrites} is what makes it
 * durable.
 */
export async function writeBlob(
  vaultId: string,
  contentHash: string,
  data: Uint8Array,
): Promise<void> {
  if (await hasBlob(vaultId, contentHash)) return;
  await withVaultLock(vaultId, async () => {
    if (await hasBlob(vaultId, contentHash)) return;
    // A whole-file payload is `iv(12) + ciphertext + tag(16)`; the header records the
    // plaintext size so a reader can tell an empty file from a corrupt one.
    const plaintextSize = Math.max(0, data.byteLength - 28);
    const header = encodeBlobHeader({
      flags: 0,
      chunkSize: 0,
      chunkCount: 1,
      plaintextSize,
    });
    await appendLocked(vaultId, contentHash, [header, data], { plaintextSize, chunkCount: 1 });
  });
}

// ── Reads ──

/** Where a blob's framed bytes live. */
async function locate(
  vaultId: string,
  contentHash: string,
): Promise<{ filePath: string; offset: number; length: number } | undefined> {
  const row = blobsRepo.findBlob(vaultId, contentHash);
  if (row === undefined) return undefined;
  return { filePath: batchPath(vaultId, row.file), offset: row.offset, length: row.length };
}

/**
 * Where a blob's framed bytes live: the batch file and the byte range.
 *
 * Diagnostics and tests use it to look at the stored frame; production code goes through
 * {@link readBlob} / {@link openBlobReader}.
 */
export async function blobLocation(
  vaultId: string,
  contentHash: string,
): Promise<{ filePath: string; offset: number; length: number } | undefined> {
  return await locate(vaultId, contentHash);
}

/** `ENOENT` from an open, as the runtime reports it. */
function isMissing(err: unknown): boolean {
  return err instanceof Error && (err as Bun.SystemError).code === "ENOENT";
}

/**
 * Resolve a blob and run `run` on it, answering `undefined` when its file is gone.
 *
 * A file is unlinked only when no row names it, so a missing file means the row is stale
 * (removed underneath the index, or a sweep beat this read): the honest answer is "the
 * store holds nothing", which a client answers by pushing the content again — and a
 * re-push repoints the row at the copy it writes.
 */
async function withLocation<T>(
  vaultId: string,
  contentHash: string,
  run: (location: { filePath: string; offset: number; length: number }) => Promise<T>,
): Promise<T | undefined> {
  const location = await locate(vaultId, contentHash);
  if (location === undefined) return undefined;
  try {
    return await run(location);
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
}

/**
 * Read a stored blob, header included, as raw bytes. Returns undefined when the store
 * does not hold it. The content route streams instead (see {@link openBlobReader}).
 */
export async function readBlob(
  vaultId: string,
  contentHash: string,
): Promise<Uint8Array | undefined> {
  return await withLocation(vaultId, contentHash, async (location) => {
    const handle = await fs.open(location.filePath, "r");
    try {
      const data = new Uint8Array(location.length);
      const { bytesRead } = await handle.read(data, 0, location.length, location.offset);
      // A short read means the row and the file disagree: answer absent rather than
      // hand back a zero-filled buffer (only tests read whole blobs this way).
      if (bytesRead !== location.length) return undefined;
      return data;
    } finally {
      await handle.close().catch(() => {});
    }
  });
}

/** What a reader needs before it can serve a blob: its chunk region and header. */
export interface BlobStat {
  /** Bytes of the chunk region — what the content route answers, without the header. */
  size: number;
  /** Where the chunk region starts, relative to the blob's own frame. */
  dataOffset: number;
  /** Absolute offset of the chunk region in {@link filePath} (frame header skipped). */
  dataStart: number;
  /** The batch file the bytes live in, for a `Bun.file(...).slice(...)` body. */
  filePath: string;
  /** The parsed v2 header, for a caller that needs the chunk layout. */
  header: BlobHeader;
  /** Batch-file modification time, used by the orphan sweep to leave fresh writes alone. */
  mtimeMs: number;
}

/**
 * Size and layout of a stored blob, or `undefined` when it is absent (or is not a v2
 * blob — pre-release changes the format in place, so a v1 frame is simply unreadable).
 */
export async function statBlob(
  vaultId: string,
  contentHash: string,
): Promise<BlobStat | undefined> {
  return await withLocation(vaultId, contentHash, async (location) => {
    const handle = await fs.open(location.filePath, "r");
    try {
      const stat = await handle.stat();
      // The row says how long the frame is; the file has to be at least that long. Without
      // this a truncated file served a `200` with the row's `Content-Length` and fewer
      // bytes on the wire, for every body too large to buffer.
      if (stat.size < location.offset + location.length) return undefined;
      const head = new Uint8Array(BLOB_HEADER_BYTES);
      const { bytesRead } = await handle.read(head, 0, BLOB_HEADER_BYTES, location.offset);
      if (bytesRead !== BLOB_HEADER_BYTES) return undefined;
      const header = parseBlobHeader(head);
      if (header === null) return undefined;
      return {
        size: location.length - BLOB_HEADER_BYTES,
        dataOffset: BLOB_HEADER_BYTES,
        dataStart: location.offset + BLOB_HEADER_BYTES,
        filePath: location.filePath,
        header,
        mtimeMs: stat.mtimeMs,
      };
    } finally {
      await handle.close().catch(() => {});
    }
  });
}

/**
 * A stored blob opened for reading, with the same handle behind both its stat and its
 * stream.
 *
 * Holding one handle for the header, the size and the stream makes all three describe
 * one inode, so a reclaim cannot leave a committed `200` with a `Content-Length` and no
 * body.
 */
export interface BlobReader {
  stat: BlobStat;
  /** The chunk region (or one inclusive range of it), owning the handle. */
  stream(range?: ByteRange): AsyncIterable<Uint8Array>;
  /**
   * The whole chunk region as one buffer, for a body small enough to hold. Closes the
   * handle, and answers `undefined` when the file is shorter than the row claims.
   *
   * A batch file holds many blobs, and a per-request `createReadStream` pays a stream's
   * allocation and readahead for bytes this request does not want; a full content GET is
   * one positional read. Large bodies still stream — the route chooses by size.
   */
  readAll(): Promise<Uint8Array<ArrayBuffer> | undefined>;
  /** Close the handle when no stream was taken (HEAD, a 416). */
  close(): Promise<void>;
}

/** Open a blob once: stat, header and stream share a single file handle. */
export async function openBlobReader(
  vaultId: string,
  contentHash: string,
): Promise<BlobReader | undefined> {
  return await withLocation(vaultId, contentHash, async (location) => {
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(location.filePath, "r");
      const stat = await handle.stat();
      // The row is the length contract, and the stream below trusts it. A file shorter
      // than the row would answer a `200`/`206` with that `Content-Length` and fewer bytes,
      // so a short file is "the store does not hold it", exactly like a missing one.
      if (stat.size < location.offset + location.length) {
        await handle.close();
        return undefined;
      }
      const head = new Uint8Array(BLOB_HEADER_BYTES);
      await handle.read(head, 0, BLOB_HEADER_BYTES, location.offset);
      const header = parseBlobHeader(head);
      if (header === null) {
        await handle.close();
        return undefined;
      }
      const dataStart = location.offset + BLOB_HEADER_BYTES;
      const dataLength = location.length - BLOB_HEADER_BYTES;
      return {
        stat: {
          size: dataLength,
          dataOffset: BLOB_HEADER_BYTES,
          // Absolute offset of the payload and the file it lives in, so a caller can
          // hand Bun a lazily-served `Bun.file(...).slice(...)` instead of a stream.
          dataStart,
          filePath: location.filePath,
          header,
          mtimeMs: stat.mtimeMs,
        },
        stream: (range) =>
          handle!.createReadStream({
            start: dataStart + (range?.start ?? 0),
            end: range === undefined ? dataStart + dataLength - 1 : dataStart + range.end,
            // The stream owns the handle: a client abort destroys it and closes the file.
            autoClose: true,
          }),
        readAll: async () => {
          const bytes = new Uint8Array(dataLength);
          try {
            const { bytesRead } = await handle!.read(bytes, 0, dataLength, dataStart);
            return bytesRead === dataLength ? bytes : undefined;
          } finally {
            await handle!.close().catch(() => {});
          }
        },
        close: () => handle!.close(),
      };
    } catch (err) {
      await handle?.close().catch(() => {});
      throw err;
    }
  });
}

// ── Chunked uploads ──

interface UploadMeta {
  chunkCount: number;
  plaintextSize: number;
}

/** Result of staging one chunk. `received` is the contiguous prefix now on disk. */
export interface UploadChunkResult {
  received: number;
  /** Bytes this request actually added (a retried index adds none). */
  newBytes: number;
}

/** Why a chunk was refused: metadata disagreeing with the upload, or a wrong size. */
export class UploadChunkError extends Error {
  constructor(readonly reason: "bad_meta" | "bad_size") {
    super(reason);
    this.name = "UploadChunkError";
  }
}

async function readUploadMeta(vaultId: string, contentHash: string): Promise<UploadMeta | null> {
  try {
    const raw = await fs.readFile(path.join(uploadDir(vaultId, contentHash), "meta.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<UploadMeta>;
    if (
      !Number.isSafeInteger(parsed.chunkCount) ||
      !Number.isSafeInteger(parsed.plaintextSize) ||
      (parsed.chunkCount as number) < 1 ||
      (parsed.chunkCount as number) > MAX_CHUNKS ||
      (parsed.plaintextSize as number) < 1
    ) {
      return null;
    }
    const chunkCount = parsed.chunkCount as number;
    const plaintextSize = parsed.plaintextSize as number;
    // A metadata file whose shape cannot describe a blob is treated as absent, so a
    // corrupt one cannot make `uploadStatus` loop over a billion indices.
    if (chunkCount !== chunkCountFor(plaintextSize)) return null;
    return { chunkCount, plaintextSize };
  } catch (err) {
    if (err instanceof Error && (err as Bun.SystemError).code === "ENOENT") return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

/** Contiguous chunks on disk, starting at 0. */
async function receivedChunks(dir: string, chunkCount: number): Promise<number> {
  let received = 0;
  for (let index = 0; index < chunkCount; index++) {
    try {
      await fs.stat(path.join(dir, `${index}.chunk`));
      received = index + 1;
    } catch (err) {
      if (err instanceof Error && (err as Bun.SystemError).code === "ENOENT") break;
      throw err;
    }
  }
  return received;
}

/** Write `data` to `filePath` atomically (temp file in the same directory + rename). */
async function writeAtomic(filePath: string, data: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${crypto.getRandomValues(new Uint8Array(6)).toHex()}.tmp`;
  try {
    await fs.writeFile(tempPath, data);
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Stage one chunk of a chunked upload, idempotently.
 *
 * The first chunk writes the upload's metadata (`chunkCount`, `plaintextSize`); every
 * later one must agree with it, or a client cannot mix two files up under one hash.
 * The chunk's **stored** size is checked as well (`4 MiB + 28`, or the shorter last
 * chunk), so a truncated request is refused here rather than discovered at assembly.
 * Re-sending an index overwrites it, which is what makes a retry safe.
 */
export async function writeUploadChunk(
  vaultId: string,
  contentHash: string,
  index: number,
  chunkCount: number,
  plaintextSize: number,
  data: Uint8Array,
): Promise<UploadChunkResult> {
  const dir = uploadDir(vaultId, contentHash);
  const meta = await readUploadMeta(vaultId, contentHash);
  if (meta !== null && (meta.chunkCount !== chunkCount || meta.plaintextSize !== plaintextSize)) {
    throw new UploadChunkError("bad_meta");
  }
  const expected = storedChunkBytes(index, plaintextSize);
  if (index < 0 || index >= chunkCount || expected !== data.byteLength) {
    throw new UploadChunkError("bad_size");
  }
  if (meta === null) {
    await writeAtomic(
      path.join(dir, "meta.json"),
      new TextEncoder().encode(JSON.stringify({ chunkCount, plaintextSize })),
    );
  }
  const chunkPath = path.join(dir, `${index}.chunk`);
  // A retried index replaces the same bytes; charging its full length again would count
  // the same staged bytes twice until the next measurement.
  let previous = 0;
  try {
    previous = (await fs.stat(chunkPath)).size;
  } catch (err) {
    if (!(err instanceof Error && (err as Bun.SystemError).code === "ENOENT")) throw err;
  }
  await writeAtomic(chunkPath, data);
  return {
    received: await receivedChunks(dir, chunkCount),
    newBytes: Math.max(0, data.byteLength - previous),
  };
}

/** How much of a staged upload exists, or `undefined` when it was never started. */
export async function uploadStatus(
  vaultId: string,
  contentHash: string,
): Promise<{ received: number; complete: boolean } | undefined> {
  const meta = await readUploadMeta(vaultId, contentHash);
  if (meta === null) {
    // A committed upload has no staging directory left. Answering 404 made a client whose
    // push response was lost upload the whole file again; the assembled blob is the
    // complete answer, in the framing the push would have committed.
    const blob = await statBlob(vaultId, contentHash);
    if (blob?.header.flags === 1) {
      return { received: blob.header.chunkCount, complete: true };
    }
    return undefined;
  }
  const received = await receivedChunks(uploadDir(vaultId, contentHash), meta.chunkCount);
  return { received, complete: received === meta.chunkCount };
}

/**
 * Turn a complete staged upload into a blob, framed as flags `1`.
 *
 * Refuses (answers `false`) when the staged parts are absent, incomplete, or describe a
 * different plaintext than the version row — the caller's response then carries
 * `chunk_missing`, and nothing is inserted, so a chain cannot point at a half-uploaded
 * file. A blob the store already holds **in the same chunk framing** wins: the staged
 * directory is dropped and the push is accepted, exactly like a duplicate single-request
 * push. A blob in a different framing is replaced — accepting it would leave the row
 * describing chunks that the store does not hold.
 */
export async function assembleUploadedChunks(
  vaultId: string,
  contentHash: string,
  chunkCount: number,
  plaintextSize: number,
): Promise<boolean> {
  const dir = uploadDir(vaultId, contentHash);
  const existing = await statBlob(vaultId, contentHash);
  if (
    existing !== undefined &&
    existing.header.flags === 1 &&
    existing.header.chunkCount === chunkCount &&
    existing.header.plaintextSize === plaintextSize
  ) {
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  }
  const meta = await readUploadMeta(vaultId, contentHash);
  if (
    meta === null ||
    meta.chunkCount !== chunkCount ||
    meta.plaintextSize !== plaintextSize ||
    meta.chunkCount !== chunkCountFor(meta.plaintextSize)
  ) {
    return false;
  }
  const received = await receivedChunks(dir, meta.chunkCount);
  if (received !== meta.chunkCount) return false;

  return await withVaultLock(vaultId, async () => {
    // A duplicate is answered before anything is appended.
    if (await hasBlob(vaultId, contentHash)) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return true;
    }
    const header = encodeBlobHeader({
      flags: 1,
      chunkSize: CHUNK_PLAINTEXT_BYTES,
      chunkCount: meta.chunkCount,
      plaintextSize: meta.plaintextSize,
    });
    const batch = await openBatch(vaultId);
    const start = batch.bytes;
    let written = 0;
    try {
      await batch.handle.write(header, 0, header.byteLength, start);
      written += header.byteLength;
      for (let index = 0; index < meta.chunkCount; index++) {
        const bytes = await fs.readFile(path.join(dir, `${index}.chunk`));
        if (bytes.byteLength !== storedChunkBytes(index, meta.plaintextSize)) {
          await batch.handle.truncate(start).catch(() => {});
          batch.bytes = start;
          return false;
        }
        await batch.handle.write(bytes, 0, bytes.byteLength, start + written);
        written += bytes.byteLength;
      }
    } catch (err) {
      await batch.handle.truncate(start).catch(() => {});
      batch.bytes = start;
      throw err;
    }
    const rows = pendingBlobs.get(vaultId) ?? [];
    rows.push({
      contentHash,
      file: batch.file,
      offset: start,
      length: written,
      plaintextSize: meta.plaintextSize,
      chunkCount: meta.chunkCount,
    });
    pendingBlobs.set(vaultId, rows);
    batch.bytes = start + written;
    await publishBatchLocked(vaultId);
    // The blob is published; failing to remove the staging directory is not a failed
    // push (the sweep will reclaim it).
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    return true;
  });
}

/**
 * Reclaim staged uploads nobody finished.
 *
 * A chunked upload lives in the vault's directory until it is assembled; a client that
 * disconnects and never retries would otherwise leave those bytes for good. The age is
 * measured on the directory's own mtime, so a retry that lands another chunk keeps it
 * alive, and the sweep runs on the same timer as retention pruning.
 */
export async function sweepUploads(maxAgeMs: number, now = Date.now()): Promise<number> {
  let removed = 0;
  let vaultIds: string[];
  try {
    vaultIds = (await fs.readdir(BASE_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (err) {
    if (err instanceof Error && (err as Bun.SystemError).code === "ENOENT") return 0;
    throw err;
  }
  for (const vaultId of vaultIds) {
    const uploads = path.join(BASE_DIR, vaultId, "uploads");
    let hashes: string[];
    try {
      hashes = (await fs.readdir(uploads, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (err) {
      if (err instanceof Error && (err as Bun.SystemError).code === "ENOENT") continue;
      throw err;
    }
    for (const hash of hashes) {
      const dir = path.join(uploads, hash);
      const stat = await fs.stat(dir).catch(() => null);
      if (stat === null) continue;
      if (now - stat.mtimeMs <= maxAgeMs) continue;
      await fs.rm(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

/**
 * Reclaim batch files no row names.
 *
 * Two states leave one behind: a crash between the rename and the row transaction (the
 * file is complete but unindexed), and a write that failed before its rename (a `.tmp`).
 * Both are unreachable — nothing can read them — so they are deleted once they are older
 * than `maxAgeMs`, which keeps a file another process is still writing out of the sweep.
 * A batch this process has open is skipped outright: its `.tmp` is live even if the age
 * gate would allow it (a short TTL, or a clock that jumped).
 */
export async function sweepBlobFiles(maxAgeMs: number, now = Date.now()): Promise<number> {
  let removed = 0;
  let vaultIds: string[];
  try {
    vaultIds = (await fs.readdir(BASE_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (err) {
    if (err instanceof Error && (err as Bun.SystemError).code === "ENOENT") return 0;
    throw err;
  }
  for (const vaultId of vaultIds) {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(vaultDir(vaultId), { withFileTypes: true });
    } catch {
      continue;
    }
    const open = batches.get(vaultId);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      const isTemp = name.endsWith(".blob.tmp");
      if (!isTemp && !name.endsWith(".blob")) continue;
      if (open !== undefined && (name === open.file || name === `${open.file}.tmp`)) continue;
      if (!isTemp && blobsRepo.hasFileRows(name)) continue;
      const full = path.join(vaultDir(vaultId), name);
      const stat = await fs.stat(full).catch(() => null);
      if (stat === null || now - stat.mtimeMs <= maxAgeMs) continue;
      await fs.rm(full, { force: true }).catch(() => {});
      removed++;
    }
  }
  return removed;
}

// ── Accounting and deletes ──

/**
 * Delete a blob from the store.
 *
 * Its file goes with it when this row was the last one pointing into it: a batch file is
 * immutable, so there are no dead bytes to rewrite — the unit of reclaim is the file.
 */
export async function deleteBlob(vaultId: string, contentHash: string): Promise<void> {
  const orphaned = blobsRepo.deleteBlobRow(vaultId, contentHash);
  if (orphaned !== undefined) {
    await fs.rm(batchPath(vaultId, orphaned), { force: true }).catch(() => {});
  }
}

/**
 * Approximate total bytes stored for a vault (sum of its blob lengths).
 * Used for per-user storage accounting; staged chunks count too.
 */
export async function sumBytes(vaultId: string): Promise<number> {
  const total = blobsRepo.sumBlobBytes(vaultId);
  // Staged chunks are disk this account is using, even though they are not a blob yet;
  // otherwise a quota-limited client could fill the host by staging uploads that are
  // never committed (the TTL only reclaims them after a day).
  return total + (await sumStagedChunks(path.join(vaultDir(vaultId), "uploads")));
}

/** Bytes a vault holds in staged chunk files (`uploads/<hash>/<index>.chunk`). */
async function sumStagedChunks(uploadsDir: string): Promise<number> {
  let hashes;
  try {
    hashes = await fs.readdir(uploadsDir, { withFileTypes: true });
  } catch (err) {
    if (err instanceof Error && (err as Bun.SystemError).code === "ENOENT") return 0;
    throw err;
  }
  let total = 0;
  for (const hashEntry of hashes) {
    if (!hashEntry.isDirectory()) continue;
    let files;
    try {
      files = await fs.readdir(path.join(uploadsDir, hashEntry.name), { withFileTypes: true });
    } catch (err) {
      if (err instanceof Error && (err as Bun.SystemError).code === "ENOENT") continue;
      throw err;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".chunk")) continue;
      const st = await fs.stat(path.join(uploadsDir, hashEntry.name, file.name)).catch(() => null);
      if (st !== null) total += st.size;
    }
  }
  return total;
}

/** List all blob content hashes stored for a vault (unreferenced-blob sweeps). */
export async function listBlobHashes(vaultId: string): Promise<string[]> {
  return await blobsRepo.listBlobHashes(vaultId);
}

/**
 * Drop the batch in progress without publishing it.
 *
 * Nothing stays open between flushes, so this is only about work not yet flushed: tests
 * use it to model a process that died mid-batch, and vault teardown calls it so a push
 * cannot keep writing into a directory that is being removed. The bytes are unreachable
 * either way and the sweep reclaims the `.tmp` file.
 */
export async function closeVaultStore(vaultId: string): Promise<void> {
  await withVaultLock(vaultId, () => discardBatch(vaultId));
}

/**
 * Delete every blob a vault holds, which is what deleting the vault means for the
 * disk (staged uploads included). The batch in progress goes with it, under the lock:
 * a push must not keep writing into a file this call is about to delete.
 */
export async function deleteVaultBlobs(vaultId: string): Promise<void> {
  await withVaultLock(vaultId, async () => {
    await discardBatch(vaultId);
    for (const file of await blobsRepo.listFiles(vaultId)) {
      await fs.rm(batchPath(vaultId, file), { force: true }).catch(() => {});
    }
    blobsRepo.deleteVaultRows(vaultId);
    await fs.rm(vaultDir(vaultId), { recursive: true, force: true });
  });
}

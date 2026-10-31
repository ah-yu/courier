import { CHUNK_PLAINTEXT_BYTES, chunkCountFor } from "@courier/shared";

/**
 * Files above this plaintext size move in chunks instead of one request.
 *
 * 8 MiB matches the engine's "exclusive" weight (`DEFAULT_OP_QUEUE_LIMITS.exclusiveBytes`)
 * and is far above a note, an image or a settings file: the chunking exists for the
 * video/PDF/PSD-sized attachments that would otherwise be encrypted whole in memory and
 * re-sent from zero after a dropped connection. Below it, one request is cheaper than
 * several round trips.
 */
export const CHUNKED_TRANSFER_THRESHOLD = 8 * 1024 * 1024;

/** Whether a version of `plaintextSize` bytes travels in chunks. */
export function shouldTransferInChunks(plaintextSize: number): boolean {
  return plaintextSize > CHUNKED_TRANSFER_THRESHOLD;
}

/** How many chunks a version of `plaintextSize` bytes occupies. */
export function chunkCountForSize(plaintextSize: number): number {
  return chunkCountFor(plaintextSize);
}

/** One chunk's plaintext bounds: `start` inclusive, `end` exclusive. */
export interface ChunkBounds {
  start: number;
  end: number;
}

/** The plaintext bytes chunk `index` covers. */
export function chunkBounds(index: number, plaintextSize: number): ChunkBounds {
  const start = index * CHUNK_PLAINTEXT_BYTES;
  return { start, end: Math.min(start + CHUNK_PLAINTEXT_BYTES, plaintextSize) };
}

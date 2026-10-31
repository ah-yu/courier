import {
  CHUNK_PLAINTEXT_BYTES,
  CHUNK_STORED_BYTES,
  chunkAdditionalData,
  chunkCountFor,
  shouldTransferInChunks,
} from "@courier/shared";
import { decryptChunkBytes, decryptCombinedBytes, sha256Hex } from "@courier/engine";

/** The two reads a preview needs: whole content, and one byte range of the chunk region. */
export interface VersionContentSource {
  getVersionContent(vaultId: string, contentHash: string): Promise<Uint8Array>;
  getVersionContentRange(
    vaultId: string,
    contentHash: string,
    start: number,
    end: number,
  ): Promise<Uint8Array>;
}

/**
 * Decrypt one stored version for a preview, using the framing its size implies.
 *
 * A version at or below 8 MiB is one whole-file payload; above it the store holds 4 MiB
 * chunks, each AEAD-bound to its position, and the preview has to read them back one at
 * a time — fetching the concatenated region whole would be right but would defeat the
 * point of chunking for exactly the videos and PDFs this is for. The plaintext is
 * assembled in memory because the preview renders from one buffer, and the whole-file
 * hash is checked so a wrong blob is refused instead of displayed.
 *
 * The size comes from the version row (`FileVersionInfo.sizeBytes` /
 * `DeletedFileInfo.previousSizeBytes`) — the same rule the engine uses to choose its
 * reader (see `docs/sync-engine.md#chunked-transfer`).
 */
export async function readVersionContent(
  source: VersionContentSource,
  vaultId: string,
  contentHash: string,
  sizeBytes: number,
  key: CryptoKey,
): Promise<Uint8Array> {
  if (!shouldTransferInChunks(sizeBytes)) {
    return await decryptCombinedBytes(key, await source.getVersionContent(vaultId, contentHash));
  }
  const count = chunkCountFor(sizeBytes);
  const plaintext = new Uint8Array(sizeBytes);
  for (let index = 0; index < count; index++) {
    const start = index * CHUNK_PLAINTEXT_BYTES;
    const end = Math.min(start + CHUNK_PLAINTEXT_BYTES, sizeBytes);
    // Every chunk but the last occupies CHUNK_STORED_BYTES, so the range is arithmetic.
    const storedStart = index * CHUNK_STORED_BYTES;
    const storedEnd = storedStart + (end - start) + 28 - 1;
    const stored = await source.getVersionContentRange(
      vaultId,
      contentHash,
      storedStart,
      storedEnd,
    );
    const chunk = await decryptChunkBytes(
      key,
      stored,
      chunkAdditionalData(contentHash, index, count, sizeBytes),
    );
    if (chunk.byteLength !== end - start) {
      throw new Error(`Version chunk ${index} has the wrong length`);
    }
    plaintext.set(chunk, start);
  }
  if ((await sha256Hex(plaintext)) !== contentHash) {
    throw new Error("Version content does not match its hash");
  }
  return plaintext;
}

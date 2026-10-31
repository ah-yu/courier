import { describe, expect, it, vi } from "vitest";
import { CHUNK_PLAINTEXT_BYTES, chunkAdditionalData, chunkCountFor } from "@courier/shared";
import {
  deriveEncryptionKey,
  encryptChunkBytes,
  encryptCombinedBytes,
  generateSalt,
  sha256Hex,
} from "@courier/engine";
import { readVersionContent } from "./version-content";

/** Concatenate byte arrays (no `Buffer`; the plugin package declares no runtime types). */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Byte-for-byte equality, without `Buffer.equals`. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * The preview reader: a dialog has a content hash and the version's size, and nothing
 * else. Below 8 MiB that is one whole-file payload; above it the store holds chunks, and
 * fetching the concatenated region whole would decrypt to nothing (each chunk carries
 * its own AEAD) — the case this helper exists for.
 */
describe("readVersionContent", () => {
  it("decrypts a whole-file version", async () => {
    const key = await deriveEncryptionKey("pw", generateSalt());
    const plaintext = new Uint8Array([1, 2, 3, 4]);
    const contentHash = await sha256Hex(plaintext);
    const stored = await encryptCombinedBytes(key, plaintext);
    const range = vi.fn();

    const result = await readVersionContent(
      {
        getVersionContent: async () => stored,
        getVersionContentRange: range,
      },
      "v1",
      contentHash,
      plaintext.byteLength,
      key,
    );

    expect(Array.from(result)).toEqual([1, 2, 3, 4]);
    // A version at or below the threshold never asks for a range.
    expect(range).not.toHaveBeenCalled();
  });

  it("fetches and decrypts a chunked version one range at a time", async () => {
    const key = await deriveEncryptionKey("pw", generateSalt());
    const size = CHUNK_PLAINTEXT_BYTES * 2 + 100;
    const plaintext = new Uint8Array(size).map((_, index) => (index * 31) % 251);
    const contentHash = await sha256Hex(plaintext);
    const count = chunkCountFor(size);

    const chunks: Uint8Array[] = [];
    for (let index = 0; index < count; index++) {
      const start = index * CHUNK_PLAINTEXT_BYTES;
      const end = Math.min(start + CHUNK_PLAINTEXT_BYTES, size);
      chunks.push(
        await encryptChunkBytes(
          key,
          plaintext.subarray(start, end),
          chunkAdditionalData(contentHash, index, count, size),
        ),
      );
    }
    const stored = concatBytes(chunks);
    const range = vi.fn(
      async (_vaultId: string, _hash: string, start: number, end: number) =>
        new Uint8Array(stored.subarray(start, end + 1)),
    );

    const result = await readVersionContent(
      {
        getVersionContent: async () => {
          throw new Error("a chunked version must not be fetched whole");
        },
        getVersionContentRange: range,
      },
      "v1",
      contentHash,
      size,
      key,
    );

    expect(sameBytes(result, plaintext)).toBe(true);
    expect(range).toHaveBeenCalledTimes(count);
    // Every chunk is `4 MiB + 28`, so the range arithmetic is the stored layout.
    expect(range.mock.calls[0]!.slice(2)).toEqual([0, CHUNK_PLAINTEXT_BYTES + 28 - 1]);
  });

  it("refuses content that does not hash to the version's content hash", async () => {
    const key = await deriveEncryptionKey("pw", generateSalt());
    const size = CHUNK_PLAINTEXT_BYTES * 2 + 100;
    const plaintext = new Uint8Array(size).fill(7);
    // The chunks are bound to `contentHash`, but the bytes are not its content.
    const contentHash = await sha256Hex(new Uint8Array([1, 2, 3]));
    const count = chunkCountFor(size);

    const chunks: Uint8Array[] = [];
    for (let index = 0; index < count; index++) {
      const start = index * CHUNK_PLAINTEXT_BYTES;
      const end = Math.min(start + CHUNK_PLAINTEXT_BYTES, size);
      chunks.push(
        await encryptChunkBytes(
          key,
          plaintext.subarray(start, end),
          chunkAdditionalData(contentHash, index, count, size),
        ),
      );
    }
    const stored = concatBytes(chunks);

    await expect(
      readVersionContent(
        {
          getVersionContent: async () => stored,
          getVersionContentRange: async (_vaultId, _hash, start, end) =>
            new Uint8Array(stored.subarray(start, end + 1)),
        },
        "v1",
        contentHash,
        size,
        key,
      ),
    ).rejects.toThrow(/does not match its hash/);
  });

  it("refuses a chunk that decrypts to the wrong length", async () => {
    const key = await deriveEncryptionKey("pw", generateSalt());
    const size = CHUNK_PLAINTEXT_BYTES * 2 + 100;
    const plaintext = new Uint8Array(size).fill(3);
    const contentHash = await sha256Hex(plaintext);
    const count = chunkCountFor(size);
    // A shorter payload under the right AAD: authentication passes, the length does not.
    const short = await encryptChunkBytes(
      key,
      plaintext.subarray(0, 10),
      chunkAdditionalData(contentHash, 0, count, size),
    );
    const stored = short;

    await expect(
      readVersionContent(
        {
          getVersionContent: async () => stored,
          // The server answers the bytes it has; the reader must notice they are short.
          getVersionContentRange: async (_vaultId, _hash, start, end) =>
            new Uint8Array(stored.subarray(start, end + 1)),
        },
        "v1",
        contentHash,
        size,
        key,
      ),
    ).rejects.toThrow(/wrong length|does not match/);
  });
});

import { describe, expect, it } from "vitest";
import {
  BLOB_HEADER_BYTES,
  CHUNKED_TRANSFER_THRESHOLD,
  CHUNK_PLAINTEXT_BYTES,
  CHUNK_STORED_BYTES,
  MAX_CHUNKS,
  chunkAdditionalData,
  chunkCountFor,
  encodeBlobHeader,
  parseBlobHeader,
  shouldTransferInChunks,
  storedChunkBytes,
  storedChunkRegionBytes,
} from "./blob";

const MiB = 1024 * 1024;

describe("blob header", () => {
  it("round-trips every field", () => {
    const header = {
      flags: 1,
      chunkSize: CHUNK_PLAINTEXT_BYTES,
      chunkCount: 3,
      plaintextSize: 9 * MiB + 17,
    };
    expect(parseBlobHeader(encodeBlobHeader(header))).toEqual(header);
  });

  it("writes a fixed 24-byte little-endian header", () => {
    const bytes = encodeBlobHeader({
      flags: 0,
      chunkSize: 0,
      chunkCount: 1,
      plaintextSize: 28,
    });
    expect(bytes.byteLength).toBe(BLOB_HEADER_BYTES);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("CBR2");
    expect(Array.from(bytes.subarray(4, 8))).toEqual([0, 0, 0, 0]);
    expect(Array.from(bytes.subarray(8, 12))).toEqual([0, 0, 0, 0]);
    expect(Array.from(bytes.subarray(12, 16))).toEqual([1, 0, 0, 0]);
    expect(Array.from(bytes.subarray(16, 24))).toEqual([28, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("refuses bytes that are not a header this store wrote", () => {
    const header = encodeBlobHeader({
      flags: 0,
      chunkSize: 0,
      chunkCount: 1,
      plaintextSize: 10,
    });
    expect(parseBlobHeader(new Uint8Array(10))).toBeNull();
    // The magic alone is not a header: a valid prefix that stops before 24 bytes must
    // not be read as one (the fields after it do not exist).
    const shortButMagic = new Uint8Array(10);
    shortButMagic.set([0x43, 0x42, 0x52, 0x32], 0);
    expect(parseBlobHeader(shortButMagic)).toBeNull();
    const wrongMagic = new Uint8Array(header);
    wrongMagic[0] = 0;
    expect(parseBlobHeader(wrongMagic)).toBeNull();
  });

  it("refuses a header whose chunk count cannot describe its plaintext", () => {
    const chunked = encodeBlobHeader({
      flags: 1,
      chunkSize: CHUNK_PLAINTEXT_BYTES,
      chunkCount: 2,
      plaintextSize: 9 * MiB,
    });
    expect(parseBlobHeader(chunked)).toBeNull(); // 9 MiB is three 4 MiB chunks
    const tooMany = encodeBlobHeader({
      flags: 1,
      chunkSize: CHUNK_PLAINTEXT_BYTES,
      chunkCount: MAX_CHUNKS + 1,
      plaintextSize: 1,
    });
    expect(parseBlobHeader(tooMany)).toBeNull();
  });

  it("refuses an unknown layout flag", () => {
    const header = encodeBlobHeader({
      flags: 0,
      chunkSize: 0,
      chunkCount: 1,
      plaintextSize: 10,
    });
    new DataView(header.buffer).setUint32(4, 2, true);
    expect(parseBlobHeader(header)).toBeNull();
  });

  it("refuses a plaintext size a version row could not carry", () => {
    const header = encodeBlobHeader({
      flags: 1,
      chunkSize: CHUNK_PLAINTEXT_BYTES,
      chunkCount: 1,
      plaintextSize: 1,
    });
    new DataView(header.buffer).setBigUint64(16, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true);
    expect(parseBlobHeader(header)).toBeNull();

    // A whole-file header isolates the size bound: its one chunk matches, so only the
    // unsafe plaintext size can reject it.
    const whole = encodeBlobHeader({ flags: 0, chunkSize: 0, chunkCount: 1, plaintextSize: 1 });
    new DataView(whole.buffer).setBigUint64(16, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true);
    expect(parseBlobHeader(whole)).toBeNull();
  });

  it("refuses a chunk count past the bound even when it matches the size", () => {
    const oversized = MAX_CHUNKS * CHUNK_PLAINTEXT_BYTES + 1;
    const header = encodeBlobHeader({
      flags: 1,
      chunkSize: CHUNK_PLAINTEXT_BYTES,
      chunkCount: MAX_CHUNKS + 1,
      plaintextSize: oversized,
    });
    // The size implies MAX_CHUNKS + 1 chunks, so the count check alone cannot reject it.
    expect(chunkCountFor(oversized)).toBe(MAX_CHUNKS + 1);
    expect(parseBlobHeader(header)).toBeNull();
  });

  it("refuses a whole-file header with no single chunk", () => {
    expect(
      parseBlobHeader(
        encodeBlobHeader({ flags: 0, chunkSize: 0, chunkCount: 0, plaintextSize: 10 }),
      ),
    ).toBeNull();
  });
});

describe("chunk arithmetic", () => {
  it("marks only payloads above the transfer threshold as chunked", () => {
    // The stored chunk is the plaintext plus an IV and a tag.
    expect(CHUNK_STORED_BYTES).toBe(CHUNK_PLAINTEXT_BYTES + 28);
    expect(shouldTransferInChunks(CHUNKED_TRANSFER_THRESHOLD)).toBe(false);
    expect(shouldTransferInChunks(CHUNKED_TRANSFER_THRESHOLD + 1)).toBe(true);
  });

  it("counts chunks, with an empty file having none", () => {
    expect(chunkCountFor(0)).toBe(0);
    expect(chunkCountFor(1)).toBe(1);
    expect(chunkCountFor(4 * MiB)).toBe(1);
    expect(chunkCountFor(4 * MiB + 1)).toBe(2);
    expect(chunkCountFor(8 * MiB)).toBe(2);
  });

  it("adds an IV and tag to every chunk, and a short last one", () => {
    expect(storedChunkBytes(0, 10 * MiB)).toBe(4 * MiB + 28);
    expect(storedChunkBytes(1, 10 * MiB)).toBe(4 * MiB + 28);
    // 10 MiB = 4 + 4 + 2, so the last chunk is 2 MiB of plaintext.
    expect(storedChunkBytes(2, 10 * MiB)).toBe(2 * MiB + 28);
    expect(storedChunkBytes(3, 10 * MiB)).toBe(0);
    expect(storedChunkBytes(-1, 10 * MiB)).toBe(0);
    expect(storedChunkRegionBytes(10 * MiB)).toBe(10 * MiB + 3 * 28);
  });
});

describe("chunk additional data", () => {
  const hash = "ab".repeat(32);

  it("is the hash followed by the index, count and plaintext size", () => {
    const aad = chunkAdditionalData(hash, 2, 5, 9 * MiB);
    expect(aad.byteLength).toBe(48);
    // The whole 32-byte hash is bound, not just its first bytes.
    const expectedHash = new Uint8Array(32).fill(0xab);
    expect(Array.from(aad.subarray(0, 32))).toEqual(Array.from(expectedHash));
    const view = new DataView(aad.buffer);
    expect(view.getUint32(32, true)).toBe(2);
    expect(view.getUint32(36, true)).toBe(5);
    expect(view.getBigUint64(40, true)).toBe(BigInt(9 * MiB));
  });

  it("accepts an empty file's zero plaintext size", () => {
    expect(() => chunkAdditionalData(hash, 0, 1, 0)).not.toThrow();
  });

  it("refuses a hash with bytes on either side of the 64 hex characters", () => {
    expect(() => chunkAdditionalData(`${hash}00`, 0, 1, 1)).toThrow(/content hash/);
    expect(() => chunkAdditionalData(`00${hash}`, 0, 1, 1)).toThrow(/content hash/);
    expect(() => chunkAdditionalData(hash.toUpperCase(), 0, 1, 1)).toThrow(/content hash/);
  });

  it("differs for a different index, count or size", () => {
    const base = chunkAdditionalData(hash, 0, 3, 9 * MiB);
    expect(chunkAdditionalData(hash, 1, 3, 9 * MiB)).not.toEqual(base);
    expect(chunkAdditionalData(hash, 0, 4, 9 * MiB)).not.toEqual(base);
    expect(chunkAdditionalData(hash, 0, 3, 9 * MiB + 1)).not.toEqual(base);
  });

  it("refuses inputs a blob could not have", () => {
    expect(() => chunkAdditionalData("nope", 0, 1, 1)).toThrow(/content hash/);
    expect(() => chunkAdditionalData(hash, -1, 1, 1)).toThrow(/index/);
    expect(() => chunkAdditionalData(hash, 0, 0, 1)).toThrow(/chunk count/);
    expect(() => chunkAdditionalData(hash, 0, 1, -1)).toThrow(/plaintext size/);
  });
});

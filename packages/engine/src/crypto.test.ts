import { describe, expect, it } from "vitest";
import { chunkAdditionalData } from "@courier/shared";
import {
  decryptChunkBytes,
  decryptString,
  deriveEncryptionKey,
  encryptChunkBytes,
  encryptString,
  exportRawKey,
  generateSalt,
  importRawKey,
  makeKeyCheck,
  Sha256,
  sha256Hex,
  verifyKeyCheck,
} from "./crypto";

describe("engine crypto — key export", () => {
  it("derives a non-extractable key by default", async () => {
    const key = await deriveEncryptionKey("pw", generateSalt());
    expect(key.extractable).toBe(false);
    await expect(exportRawKey(key)).rejects.toThrow(/non-extractable/);
  });

  it("derives an extractable key on request, and it round-trips", async () => {
    const salt = generateSalt();
    const key = await deriveEncryptionKey("pw", salt, true);
    expect(key.extractable).toBe(true);

    const b64 = await exportRawKey(key);
    const reimported = await importRawKey(b64);

    // Same key material: a payload encrypted under one decrypts under the other.
    const payload = await encryptString(key, "hello");
    await expect(decryptString(reimported, payload)).resolves.toBe("hello");
    // …and the re-imported key still satisfies the server's canary.
    await expect(verifyKeyCheck(reimported, await makeKeyCheck(key))).resolves.toBe(true);
  });

  it("rejects a malformed raw key", async () => {
    await expect(importRawKey("AAAA")).rejects.toThrow(/Invalid AES key length/);
  });
});

describe("engine crypto — chunks", () => {
  const hash = "cd".repeat(32);

  it("round-trips a chunk under its own additional data", async () => {
    const key = await deriveEncryptionKey("pw", generateSalt());
    const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
    const aad = chunkAdditionalData(hash, 1, 3, 9 * 1024 * 1024);

    const stored = await encryptChunkBytes(key, plaintext, aad);
    expect(stored.byteLength).toBe(plaintext.byteLength + 28);
    await expect(decryptChunkBytes(key, stored, aad)).resolves.toEqual(plaintext);
  });

  it("refuses a chunk decrypted at another index, count or file", async () => {
    const key = await deriveEncryptionKey("pw", generateSalt());
    const plaintext = new Uint8Array(64).fill(7);
    const stored = await encryptChunkBytes(
      key,
      plaintext,
      chunkAdditionalData(hash, 0, 3, 9 * 1024 * 1024),
    );

    // Reordering, truncating, or moving the chunk must all fail authentication.
    await expect(
      decryptChunkBytes(key, stored, chunkAdditionalData(hash, 1, 3, 9 * 1024 * 1024)),
    ).rejects.toThrow();
    await expect(
      decryptChunkBytes(key, stored, chunkAdditionalData(hash, 0, 4, 9 * 1024 * 1024)),
    ).rejects.toThrow();
    await expect(
      decryptChunkBytes(key, stored, chunkAdditionalData("ef".repeat(32), 0, 3, 9 * 1024 * 1024)),
    ).rejects.toThrow();
  });
});

describe("engine crypto — incremental SHA-256", () => {
  it("matches the published FIPS 180-4 vectors", () => {
    expect(new Sha256().digestHex()).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(new Sha256().update(new TextEncoder().encode("abc")).digestHex()).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      new Sha256()
        .update(
          new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
        )
        .digestHex(),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("agrees with Web Crypto around every block boundary", async () => {
    for (const size of [0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 4096, 65_535]) {
      const bytes = new Uint8Array(size).map((_, index) => (index * 31 + 7) & 0xff);
      expect(new Sha256().update(bytes).digestHex()).toBe(await sha256Hex(bytes));
    }
  });

  it("produces the same digest however the message is split", async () => {
    const bytes = new Uint8Array(300_000).map((_, index) => (index * 31 + 7) & 0xff);
    const oneShot = await sha256Hex(bytes);

    const hasher = new Sha256();
    for (let offset = 0; offset < bytes.byteLength; offset += 7919) {
      hasher.update(bytes.subarray(offset, Math.min(offset + 7919, bytes.byteLength)));
    }
    expect(hasher.digestHex()).toBe(oneShot);
  });

  it("refuses a second digest", () => {
    const hasher = new Sha256().update(new Uint8Array([1]));
    hasher.digestHex();
    expect(() => hasher.digestHex()).toThrow(/twice/);
  });
});

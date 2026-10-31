import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { truncate, utimes } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { removeDirWithRetry } from "@courier/testing";
import { BLOB_HEADER_BYTES, CHUNK_PLAINTEXT_BYTES } from "@courier/shared";
import { runMigrations } from "../db/migrations";

/** UTF-8 bytes, so a blob's payload can be written as readable text in a test. */
function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** The chunk region of a stored blob — the header the server adds is not payload. */
function payloadOf(stored: Uint8Array | undefined): number[] {
  return Array.from(stored?.subarray(BLOB_HEADER_BYTES) ?? []);
}

/** Drain a byte stream into one array, for the streaming cases. */
async function collect(stream: AsyncIterable<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  for await (const chunk of stream) out.push(...(chunk as Uint8Array));
  return out;
}

/** One chunk's worth of bytes, as an upload would send them (ciphertext is opaque). */
function chunkPayload(index: number, plaintextSize: number): Uint8Array {
  const count = Math.ceil(plaintextSize / CHUNK_PLAINTEXT_BYTES);
  const last = index === count - 1;
  const plaintext = last ? plaintextSize - index * CHUNK_PLAINTEXT_BYTES : CHUNK_PLAINTEXT_BYTES;
  const stored = new Uint8Array(plaintext + 28);
  stored.fill(index + 1);
  return stored;
}

let dir: string;
let sqlite: Database;
let closeDb: () => void;
let store: typeof import("./blob-store");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "courier-blob-store-"));
  process.env.BLOB_STORE_DIR = join(dir, "blobs");
  process.env.SQLITE_PATH = join(dir, "test.db");
  const database = await import("../db/index");
  sqlite = database.sqlite;
  closeDb = database.closeDb;
  runMigrations(sqlite);
  // Loaded after the environment is set: both modules read it on import.
  store = await import("./blob-store");
});

afterAll(async () => {
  closeDb();
  await removeDirWithRetry(dir);
  delete process.env.BLOB_STORE_DIR;
  delete process.env.SQLITE_PATH;
});

beforeEach(async () => {
  // Drops the batch in progress and removes the vault's files with its rows.
  await store.deleteVaultBlobs("vault");
  sqlite.prepare("INSERT OR IGNORE INTO vaults (id, name) VALUES ('vault', 'vault')").run();
});

describe("blob store", () => {
  it("keeps the bytes a hash already holds instead of rewriting them", async () => {
    await store.writeBlob("vault", "hash-1", bytes("first ciphertext"));
    await store.flushBlobWrites("vault");
    const size = await store.sumBytes("vault");

    await store.writeBlob("vault", "hash-1", bytes("second ciphertext"));
    await store.flushBlobWrites("vault");

    // Same plaintext, another IV: rewriting would change nothing a peer could see, and
    // the bytes are content-addressed by the plaintext hash, not by the ciphertext.
    expect(payloadOf(await store.readBlob("vault", "hash-1"))).toEqual(
      Array.from(bytes("first ciphertext")),
    );
    expect(await store.sumBytes("vault")).toBe(size);
  });

  it("stores the ciphertext byte for byte, with no encoding in between", async () => {
    // Bytes no UTF-8 string can carry: the store used to hold base64 text, which a
    // binary payload cannot survive.
    const payload = new Uint8Array([0x00, 0xff, 0x80, 0xc3, 0x28, 0x0a, 0x7f]);
    await store.writeBlob("vault", "hash-3", payload);
    await store.flushBlobWrites("vault");

    expect(payloadOf(await store.readBlob("vault", "hash-3"))).toEqual(Array.from(payload));
  });

  it("frames a whole-file payload as one v2 chunk", async () => {
    const payload = bytes("payload");
    await store.writeBlob("vault", "hash-4", payload);
    await store.flushBlobWrites("vault");

    const stat = await store.statBlob("vault", "hash-4");
    expect(stat).toBeDefined();
    expect(stat!.size).toBe(payload.byteLength);
    expect(stat!.dataOffset).toBe(BLOB_HEADER_BYTES);
    expect(stat!.header.flags).toBe(0);
    expect(stat!.header.chunkCount).toBe(1);
  });

  it("streams the chunk region, and one range of it", async () => {
    const payload = bytes("0123456789");
    await store.writeBlob("vault", "hash-5", payload);
    await store.flushBlobWrites("vault");

    // One reader per stream: the stream owns the handle and closes it at the end.
    const whole = (await store.openBlobReader("vault", "hash-5"))!;
    expect(whole.stat.size).toBe(payload.byteLength);
    expect(await collect(whole.stream())).toEqual(Array.from(payload));

    const ranged = (await store.openBlobReader("vault", "hash-5"))!;
    expect(await collect(ranged.stream({ start: 2, end: 5 }))).toEqual(
      Array.from(payload.subarray(2, 6)),
    );
  });

  it("is visible to the batch before the flush and readable only after it", async () => {
    // A `rename` in the same batch as the `create` that carried its bytes has to find
    // them (that is what `hasBlob` answers from the pending list), but no reader may
    // see a blob whose bytes are not flushed.
    await store.writeBlob("vault", "hash-6", bytes("pending"));

    expect(await store.hasBlob("vault", "hash-6")).toBe(true);
    expect(await store.readBlob("vault", "hash-6")).toBeUndefined();

    await store.flushBlobWrites("vault");
    expect(payloadOf(await store.readBlob("vault", "hash-6"))).toEqual(
      Array.from(bytes("pending")),
    );
  });

  it("reads a row as absent when its file is gone or short", async () => {
    await store.writeBlob("vault", "hash-7", bytes("payload"));
    await store.flushBlobWrites("vault");
    const location = (await store.blobLocation("vault", "hash-7"))!;

    // A file someone truncated: a row alone is not a blob, and a short read must not be
    // served as a short payload.
    await truncate(location.filePath, 4);
    expect(await store.readBlob("vault", "hash-7")).toBeUndefined();
    expect(await store.hasBlob("vault", "hash-7")).toBe(false);

    await rmSync(location.filePath, { force: true });
    expect(await store.statBlob("vault", "hash-7")).toBeUndefined();
    expect(await store.readBlob("vault", "hash-7")).toBeUndefined();
  });

  it("unlinks a batch file once no row names it", async () => {
    await store.writeBlob("vault", "hash-x", bytes("xxxx"));
    await store.writeBlob("vault", "hash-y", bytes("yyyy"));
    await store.flushBlobWrites("vault");
    const shared = (await store.blobLocation("vault", "hash-x"))!;
    // One batch, one file: this is where the amortized flush comes from.
    expect((await store.blobLocation("vault", "hash-y"))!.filePath).toBe(shared.filePath);

    await store.deleteBlob("vault", "hash-x");
    // A live row still points into it, so the file stays — and the survivor is untouched.
    expect(existsSync(shared.filePath)).toBe(true);
    expect(payloadOf(await store.readBlob("vault", "hash-y"))).toEqual(Array.from(bytes("yyyy")));

    await store.deleteBlob("vault", "hash-y");
    expect(existsSync(shared.filePath)).toBe(false);
  });

  it("reads a small body in one positional read, and answers absent when it is short", async () => {
    await store.writeBlob("vault", "hash-body", bytes("body"));
    await store.flushBlobWrites("vault");

    const whole = (await store.openBlobReader("vault", "hash-body"))!;
    expect(Array.from((await whole.readAll())!)).toEqual(Array.from(bytes("body")));

    // Long enough for the header, short of the body: a file shorter than its row is
    // "absent" on every read path — never a 200 with the row's length and fewer bytes.
    const location = (await store.blobLocation("vault", "hash-body"))!;
    await truncate(location.filePath, location.offset + BLOB_HEADER_BYTES + 2);
    expect(await store.openBlobReader("vault", "hash-body")).toBeUndefined();
    expect(await store.statBlob("vault", "hash-body")).toBeUndefined();
    expect(await store.hasBlob("vault", "hash-body")).toBe(false);
  });

  it("fails the next flush when a batch could not be published", async () => {
    // The failure this pins: a publish covers every blob the vault has pending, including
    // the ones another request appended. When it fails, their rows are gone, so a later
    // flush must fail too — otherwise that other request commits a version whose content
    // no peer can ever fetch, and nothing in its own pass would notice.
    const fsModule = await import("fs/promises");
    const rename = vi
      .spyOn(fsModule.default, "rename")
      .mockRejectedValueOnce(new Error("no space left on device"));
    try {
      await store.writeBlob("vault", "hash-boom", bytes("boom"));
      await expect(store.flushBlobWrites("vault")).rejects.toThrow(/no space left/);
    } finally {
      rename.mockRestore();
    }

    await expect(store.flushBlobWrites("vault")).rejects.toThrow(/could not be published/);
    // That was the one shot: the retry appends the bytes again and publishes them.
    expect(await store.hasBlob("vault", "hash-boom")).toBe(false);
    await store.writeBlob("vault", "hash-boom", bytes("boom"));
    await store.flushBlobWrites("vault");
    expect(payloadOf(await store.readBlob("vault", "hash-boom"))).toEqual(
      Array.from(bytes("boom")),
    );
  });

  it("sweeps a batch file no row names, and leaves a live one alone", async () => {
    await store.writeBlob("vault", "hash-live", bytes("live"));
    await store.flushBlobWrites("vault");
    const live = (await store.blobLocation("vault", "hash-live"))!;
    // A crash between the rename and the row transaction leaves exactly this: a complete
    // file nothing names. The age gate is what protects a file another process is writing.
    const orphan = join(dir, "blobs", "vault", "00000000-orphan.blob");
    writeFileSync(orphan, Buffer.from("unreferenced"));
    // A write that died before its rename leaves this, and nothing will ever read it.
    const torn = join(dir, "blobs", "vault", "00000000-torn.blob.tmp");
    writeFileSync(torn, Buffer.from("half a batch"));

    const later = Date.now() + 48 * 60 * 60 * 1000;
    expect(await store.sweepBlobFiles(24 * 60 * 60 * 1000, later)).toBe(2);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(torn)).toBe(false);
    expect(existsSync(live.filePath)).toBe(true);
  });

  it("refuses a vault id that resolves outside the store", async () => {
    await expect(store.writeBlob("../other", "hash", bytes("payload"))).rejects.toThrow(/Blob/);
  });

  it("stops charging for bytes whose row was deleted", async () => {
    await store.writeBlob("vault", "hash-a", bytes("aaaa"));
    await store.writeBlob("vault", "hash-b", bytes("bbbb"));
    await store.flushBlobWrites("vault");
    expect(await store.sumBytes("vault")).toBe(2 * (BLOB_HEADER_BYTES + 4));

    // Deleting a row (an orphan sweep, a pruned chain) removes the accounting entry. The
    // file itself stays, because `hash-b` still names bytes inside it — and it is unlinked
    // as soon as that last row goes (the case above).
    await store.deleteBlob("vault", "hash-a");
    expect(await store.sumBytes("vault")).toBe(BLOB_HEADER_BYTES + 4);
    expect(await store.readBlob("vault", "hash-a")).toBeUndefined();
    expect(payloadOf(await store.readBlob("vault", "hash-b"))).toEqual(Array.from(bytes("bbbb")));
  });

  it("counts staged chunks as bytes the account holds", async () => {
    const hash = "a".repeat(64);
    expect(await store.sumBytes("vault")).toBe(0);

    await store.writeUploadChunk("vault", hash, 0, 1, 1024, new Uint8Array(1024 + 28));
    expect(await store.sumBytes("vault")).toBe(1024 + 28);

    await store.assembleUploadedChunks("vault", hash, 1, 1024);
    expect(await store.sumBytes("vault")).toBe(BLOB_HEADER_BYTES + 1024 + 28);
  });

  it("ignores an upload whose metadata cannot describe a blob", async () => {
    const hash = "b".repeat(64);
    const staged = join(dir, "blobs", "vault", "uploads", hash);
    mkdirSync(staged, { recursive: true });
    writeFileSync(
      join(staged, "meta.json"),
      JSON.stringify({ chunkCount: 1_000_000_000, plaintextSize: 1 }),
    );

    expect(await store.uploadStatus("vault", hash)).toBeUndefined();
  });
});

/**
 * Chunked uploads: the server only stages opaque chunks and assembles them on the push
 * that names them. The cases below pin that the staged sizes are checked, that a
 * re-send is idempotent, that an incomplete upload cannot become a blob, and that a
 * sweep reclaims one nobody finished.
 */
describe("chunked uploads", () => {
  const PLAINTEXT = CHUNK_PLAINTEXT_BYTES * 2 + 1024; // three chunks, last one short

  async function stageAll(hash: string): Promise<void> {
    const count = Math.ceil(PLAINTEXT / CHUNK_PLAINTEXT_BYTES);
    for (let index = 0; index < count; index++) {
      await store.writeUploadChunk(
        "vault",
        hash,
        index,
        count,
        PLAINTEXT,
        chunkPayload(index, PLAINTEXT),
      );
    }
  }

  it("reports how much of an upload is on disk, and assembles it into one blob", async () => {
    expect(await store.uploadStatus("vault", "c".repeat(64))).toBeUndefined();
    const hash = "c".repeat(64);
    const count = Math.ceil(PLAINTEXT / CHUNK_PLAINTEXT_BYTES);

    expect(
      await store.writeUploadChunk("vault", hash, 0, count, PLAINTEXT, chunkPayload(0, PLAINTEXT)),
    ).toEqual({ received: 1, newBytes: CHUNK_PLAINTEXT_BYTES + 28 });
    expect(await store.uploadStatus("vault", hash)).toEqual({ received: 1, complete: false });

    await stageAll(hash);
    expect(await store.uploadStatus("vault", hash)).toEqual({
      received: count,
      complete: true,
    });
    expect(await store.assembleUploadedChunks("vault", hash, count, PLAINTEXT)).toBe(true);
    // A committed upload answers the complete prefix from the blob, not 404: a lost push
    // response must not force the whole file to be staged again.
    expect(await store.uploadStatus("vault", hash)).toEqual({
      received: count,
      complete: true,
    });

    const stat = await store.statBlob("vault", hash);
    expect(stat).toBeDefined();
    expect(stat!.header.flags).toBe(1);
    expect(stat!.header.chunkCount).toBe(count);
    expect(stat!.header.plaintextSize).toBe(PLAINTEXT);
    expect(stat!.size).toBe(PLAINTEXT + count * 28);
  });

  it("refuses an incomplete upload instead of publishing one", async () => {
    const hash = "d".repeat(64);
    const count = Math.ceil(PLAINTEXT / CHUNK_PLAINTEXT_BYTES);
    await store.writeUploadChunk("vault", hash, 0, count, PLAINTEXT, chunkPayload(0, PLAINTEXT));

    expect(await store.assembleUploadedChunks("vault", hash, count, PLAINTEXT)).toBe(false);
    expect(await store.statBlob("vault", hash)).toBeUndefined();
  });

  it("refuses a chunk whose metadata or length disagrees with the upload", async () => {
    const hash = "e".repeat(64);
    const count = Math.ceil(PLAINTEXT / CHUNK_PLAINTEXT_BYTES);
    await store.writeUploadChunk("vault", hash, 0, count, PLAINTEXT, chunkPayload(0, PLAINTEXT));

    await expect(
      store.writeUploadChunk("vault", hash, 1, count + 1, PLAINTEXT, chunkPayload(1, PLAINTEXT)),
    ).rejects.toMatchObject({ reason: "bad_meta" });
    await expect(
      store.writeUploadChunk("vault", hash, 1, count, PLAINTEXT, new Uint8Array(10)),
    ).rejects.toMatchObject({ reason: "bad_size" });
  });

  it("lets a retried chunk overwrite the same index", async () => {
    const hash = "f".repeat(64);
    const count = Math.ceil(PLAINTEXT / CHUNK_PLAINTEXT_BYTES);
    await store.writeUploadChunk("vault", hash, 0, count, PLAINTEXT, chunkPayload(0, PLAINTEXT));
    // The same bytes again: no new quota, but the same resume point.
    const retried = await store.writeUploadChunk(
      "vault",
      hash,
      0,
      count,
      PLAINTEXT,
      chunkPayload(0, PLAINTEXT),
    );

    expect(retried).toEqual({ received: 1, newBytes: 0 });
  });

  it("reclaims a staged upload older than the TTL", async () => {
    const hash = "9".repeat(64);
    const count = Math.ceil(PLAINTEXT / CHUNK_PLAINTEXT_BYTES);
    await store.writeUploadChunk("vault", hash, 0, count, PLAINTEXT, chunkPayload(0, PLAINTEXT));
    const staged = join(dir, "blobs", "vault", "uploads", hash);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(staged, old, old);

    expect(await store.sweepUploads(24 * 60 * 60 * 1000)).toBe(1);
    expect(await store.uploadStatus("vault", hash)).toBeUndefined();
    // A fresh upload is not swept.
    await store.writeUploadChunk("vault", hash, 0, count, PLAINTEXT, chunkPayload(0, PLAINTEXT));
    expect(await store.sweepUploads(24 * 60 * 60 * 1000)).toBe(0);
  });
});

/**
 * What a crash or a lost file leaves behind, and what a re-push is allowed to repair.
 *
 * The unit is one immutable file per batch: nothing rewrites it, nothing truncates it, and
 * a file is deleted the moment its last row goes. A crash can therefore only leave a file
 * no row names (collected by the sweep), never a row whose bytes are gone — except when
 * something outside the process removes or truncates the file, which is the case the
 * bottom two cover.
 */
describe("blob store recovery", () => {
  it("publishes the file before the rows that name it", async () => {
    await store.writeBlob("vault", "hash-r", bytes("recovery"));
    await store.flushBlobWrites("vault");

    const location = (await store.blobLocation("vault", "hash-r"))!;
    // The row names a range that the file really holds: had the rows committed first, a
    // crash here would leave a chain pointing at bytes that were never written.
    expect(existsSync(location.filePath)).toBe(true);
    expect(statSync(location.filePath).size).toBe(location.offset + location.length);
    expect(payloadOf(await store.readBlob("vault", "hash-r"))).toEqual(
      Array.from(bytes("recovery")),
    );
  });

  it("repoints a row whose bytes are gone when the same content is pushed again", async () => {
    await store.writeBlob("vault", "hash-lost", bytes("lost then found"));
    await store.flushBlobWrites("vault");
    const first = (await store.blobLocation("vault", "hash-lost"))!;
    await truncate(first.filePath, 0);

    // The row exists but names bytes that are not there: it reads as absent, which is what
    // makes a client push the content again.
    expect(await store.readBlob("vault", "hash-lost")).toBeUndefined();
    expect(await store.hasBlob("vault", "hash-lost")).toBe(false);

    await store.writeBlob("vault", "hash-lost", bytes("lost then found"));
    await store.flushBlobWrites("vault");

    // The re-push has to repoint the stale row, not be ignored by it.
    expect(await store.hasBlob("vault", "hash-lost")).toBe(true);
    expect(payloadOf(await store.readBlob("vault", "hash-lost"))).toEqual(
      Array.from(bytes("lost then found")),
    );
  });

  it("lets a re-push heal a hash whose file was deleted", async () => {
    await store.writeBlob("vault", "hash-gone", bytes("gone"));
    await store.flushBlobWrites("vault");
    const location = (await store.blobLocation("vault", "hash-gone"))!;
    rmSync(location.filePath, { force: true });

    // Nothing can read the old location, so the hash reads as absent and the re-push owns
    // a fresh file; without the upsert the row would stay behind forever.
    expect(await store.hasBlob("vault", "hash-gone")).toBe(false);
    await store.writeBlob("vault", "hash-gone", bytes("gone"));
    await store.flushBlobWrites("vault");

    expect(payloadOf(await store.readBlob("vault", "hash-gone"))).toEqual(
      Array.from(bytes("gone")),
    );
  });

  it("does not publish bytes a batch never finished writing", async () => {
    // A batch that is dropped before its flush (a failed write, a process that died
    // mid-batch) leaves nothing a reader or a row can point at.
    await store.writeBlob("vault", "hash-abandoned", bytes("abandoned"));
    await store.closeVaultStore("vault");

    expect(await store.hasBlob("vault", "hash-abandoned")).toBe(false);
    expect(await store.readBlob("vault", "hash-abandoned")).toBeUndefined();
    expect(
      readdirSync(join(dir, "blobs", "vault")).filter((name) => name.endsWith(".blob")),
    ).toEqual([]);

    await store.writeBlob("vault", "hash-abandoned", bytes("abandoned"));
    await store.flushBlobWrites("vault");
    expect(payloadOf(await store.readBlob("vault", "hash-abandoned"))).toEqual(
      Array.from(bytes("abandoned")),
    );
  });
});

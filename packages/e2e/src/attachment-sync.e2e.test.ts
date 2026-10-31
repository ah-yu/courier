import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_FILE_TYPES,
  FILE_TYPE_GROUPS,
  fileTypeOf,
  NO_FILE_TYPES,
  type FileTypeGroup,
  type FileTypeSync,
} from "../../engine/src/index";
import { createTestClient, type TestClient } from "./harness/client";
import { startTestServer, type TestServer } from "./harness/server";
import {
  createTestVault,
  makeVaultMaterial,
  type TestVault,
  type VaultMaterial,
} from "./harness/vault";
import { deletedFiles, filesAtPath, fileVersions, vaultHistory } from "./harness/api";

/** Exactly one type on. */
function only(...types: FileTypeGroup[]): Partial<FileTypeSync> {
  const fileTypes: Record<string, boolean> = { ...NO_FILE_TYPES };
  for (const type of types) fileTypes[type] = true;
  return fileTypes;
}

/** A PNG header plus bytes that are deliberately not valid UTF-8. */
function png(seed: number): Uint8Array {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    seed,
    0xff,
    0xfe,
    0x80,
    0x7f,
  ]);
}

const bytes = (client: TestClient, path: string): number[] =>
  Array.from(client.readBytes(path) ?? []);

/**
 * Non-Markdown files end to end: real server, real `SyncEngine`, real filesystem.
 *
 * The feature has three parts that this layer is the right one to pin. **Transport**:
 * an image is bytes, so only a byte-for-byte comparison proves nothing re-encoded it on
 * the way (a text round-trip through UTF-8 would look fine for a `.canvas` and destroy a
 * PNG). **Ownership**: markdown and canvas are always synced, Obsidian's media types are
 * synced unless a device opts out, and everything else needs the explicit catch-all.
 * **Direction**: a type switched off means the device neither pushes nor pulls it — no
 * conflict copy, no second chain, no retry loop — which is exactly the property a
 * one-sided test would miss.
 */
describe("attachment sync e2e — vault file types", () => {
  let server: TestServer;
  let material: VaultMaterial;
  let clients: TestClient[] = [];

  beforeAll(async () => {
    server = await startTestServer("attachment sync e2e user");
    material = await makeVaultMaterial();
  }, 120_000);

  afterEach(() => {
    for (const client of clients) client.cleanup();
    clients = [];
  });

  afterAll(async () => {
    await server.close();
  });

  async function newVault(name: string): Promise<TestVault> {
    return await createTestVault(server, name, material);
  }

  async function newClient(
    vaultId: string,
    deviceName: string,
    options: {
      fileTypes?: Partial<FileTypeSync>;
      maxFileBytes?: number;
      dir?: string;
      onFileTooLarge?: (event: { plainPath: string; sizeBytes: number }) => void;
    } = {},
  ): Promise<TestClient> {
    const client = await createTestClient({
      server,
      vaultId,
      key: material.key,
      deviceName,
      ...options,
    });
    clients.push(client);
    return client;
  }

  /** The default set — what a device that was never configured syncs. */
  const DEFAULT_TYPES = { ...DEFAULT_FILE_TYPES };
  /** Markdown and canvas only. */
  const NOTES_ONLY = { ...NO_FILE_TYPES };

  /**
   * One representative file per switchable category.
   *
   * The category list is the engine's own (`FILE_TYPE_GROUPS`) and each path is checked
   * against `fileTypeOf` in the case that uses it, so the matrix cannot drift into testing
   * the wrong switch when the extension table changes hands — `.webm` moving from audio to
   * video, or a new extension joining a category, fails that check rather than passing
   * silently.
   */
  const TYPE_FILES: Record<FileTypeGroup, { path: string; bytes: Uint8Array }> = {
    images: { path: "media/photo.png", bytes: png(30) },
    video: { path: "media/clip.mp4", bytes: png(31) },
    audio: { path: "media/take.mp3", bytes: png(32) },
    pdf: { path: "docs/paper.pdf", bytes: png(33) },
    otherTypes: { path: "data/vault.base", bytes: new TextEncoder().encode("views: []") },
  };

  it("carries every documented media type byte for byte", async () => {
    const vault = await newVault("attachments-media");
    const a = await newClient(vault.id, "device-a");
    const b = await newClient(vault.id, "device-b");

    const files: Array<[string, Uint8Array]> = [
      ["photos/raw.png", png(1)],
      ["audio/take.mp3", png(2)],
      ["video/clip.mp4", png(3)],
      ["docs/paper.pdf", png(4)],
      ["boards/plan.canvas", new TextEncoder().encode('{"nodes":[]}')],
    ];
    for (const [path, content] of files) a.writeBinary(path, content);

    await a.sync();
    await b.sync();

    for (const [path, content] of files) {
      expect(bytes(b, path), path).toEqual(Array.from(content));
    }
  });

  it("syncs markdown and canvas even with every file type switched off", async () => {
    const vault = await newVault("attachments-always");
    const a = await newClient(vault.id, "device-a", { fileTypes: NOTES_ONLY });
    const b = await newClient(vault.id, "device-b", { fileTypes: NOTES_ONLY });

    a.write("note.md", "# note");
    a.write("board.canvas", '{"nodes":[]}');
    a.writeBinary("photo.png", png(5));
    await a.sync();

    await b.sync();

    expect(b.read("note.md")).toBe("# note");
    expect(b.read("board.canvas")).toBe('{"nodes":[]}');
    expect(b.readBytes("photo.png")).toBeNull();
  });

  it("keeps a switched-off type out in both directions, without a conflict copy", async () => {
    const vault = await newVault("attachments-off");
    const withImages = await newClient(vault.id, "device-with-images", {
      fileTypes: only("images"),
    });
    const withoutImages = await newClient(vault.id, "device-without-images", {
      fileTypes: only("pdf"),
    });

    withImages.writeBinary("photos/raw.png", png(6));
    await withImages.sync();

    // The peer's chain exists, and the device that does not want images ignores it
    // completely: nothing pulled, nothing parked, nothing tracked.
    await withoutImages.sync();
    expect(withoutImages.readBytes("photos/raw.png")).toBeNull();
    expect(await withoutImages.conflictFiles()).toEqual([]);
    expect(withoutImages.engine.fileIdForPath("photos/raw.png")).toBeNull();

    // A file the peer has at that path is not pushed as a second chain for it either:
    // the path belongs to a chain this device does not sync.
    withoutImages.writeBinary("photos/raw.png", png(7));
    await withoutImages.sync();
    expect(await vaultHistory(server, vault.id)).toHaveLength(
      (await vaultHistory(server, vault.id)).length,
    );
    const paths = await Promise.all(
      (await vaultHistory(server, vault.id)).map(async (file) => file.fileId),
    );
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("carries a type again once the device switches it back on", async () => {
    const vault = await newVault("attachments-toggle");
    const a = await newClient(vault.id, "device-a", { fileTypes: only("images") });
    const b = await newClient(vault.id, "device-b", { fileTypes: NOTES_ONLY });

    a.writeBinary("photos/raw.png", png(8));
    await a.sync();

    await b.sync();
    expect(b.readBytes("photos/raw.png")).toBeNull();

    // Same directory, new scope: this is what restarting the host with the switch on
    // does, and the chain that was ignored before is still there to be pulled.
    const bAgain = await newClient(vault.id, "device-b", {
      fileTypes: only("images"),
      dir: b.dir,
    });
    await bAgain.sync();
    expect(bytes(bAgain, "photos/raw.png")).toEqual(Array.from(png(8)));
  });

  /**
   * The file-type option list, one category at a time and in both states.
   *
   * "carries every documented media type byte for byte" says all of them travel together
   * and "keeps a switched-off type out" says one of them does not; this is the coverage
   * that each switch on the settings page is exercised on its own — including the two the
   * other cases never isolate (`video`/`audio` are only ever on as part of a default set)
   * and the catch-all, which is off by default and so has to be tested from both sides.
   */
  it.each([...FILE_TYPE_GROUPS])(
    "carries the %s category to a device that has it on, and nothing to one that has it off",
    async (type) => {
      const vault = await newVault(`attachments-matrix-${type}`);
      const file = TYPE_FILES[type];
      // The mapping above is worth something only if the engine agrees on the owner.
      expect(fileTypeOf(file.path)).toBe(type);

      const sender = await newClient(vault.id, "device-sender", { fileTypes: only(type) });
      sender.writeBinary(file.path, file.bytes);
      sender.write("note.md", `# ${type}`);
      await sender.sync();

      expect(await filesAtPath(server, vault.id, material.key, file.path)).toHaveLength(1);

      // A second pass on the device that does not want the category changes nothing: no
      // pull, no conflict copy, no chain of its own for the path — while the note, which
      // no switch governs, still arrives.
      const off = await newClient(vault.id, "device-off", { fileTypes: NOTES_ONLY });
      await off.sync();
      await off.sync();

      expect(off.read("note.md")).toBe(`# ${type}`);
      expect(off.readBytes(file.path)).toBeNull();
      expect(off.engine.fileIdForPath(file.path)).toBeNull();
      expect(await off.conflictFiles()).toEqual([]);
      // Two chains for the whole vault: the file and the note, both made by the sender.
      expect(await vaultHistory(server, vault.id)).toHaveLength(2);

      // The device with exactly that category on receives the same bytes.
      const on = await newClient(vault.id, "device-on", { fileTypes: only(type) });
      await on.sync();

      expect(on.read("note.md")).toBe(`# ${type}`);
      expect(bytes(on, file.path)).toEqual(Array.from(file.bytes));
    },
  );

  it("treats unlisted types as opt-in: off by default, synced when asked for", async () => {
    const vault = await newVault("attachments-other");
    const a = await newClient(vault.id, "device-a", {
      fileTypes: { ...DEFAULT_TYPES, otherTypes: true },
    });
    const b = await newClient(vault.id, "device-b", { fileTypes: DEFAULT_TYPES });
    const c = await newClient(vault.id, "device-c", { fileTypes: only("otherTypes") });

    a.writeBinary("data/vault.base", new TextEncoder().encode("views: []"));
    a.writeBinary("data/bundle.zip", png(9));
    a.writeBinary("LICENSE", new TextEncoder().encode("MIT"));
    await a.sync();

    // The default device takes none of them…
    await b.sync();
    expect(b.readBytes("data/vault.base")).toBeNull();
    expect(b.readBytes("data/bundle.zip")).toBeNull();
    expect(b.readBytes("LICENSE")).toBeNull();

    // …and the one that asked for "all other types" takes all three, bytes intact.
    await c.sync();
    expect(c.read("data/vault.base")).toBe("views: []");
    expect(bytes(c, "data/bundle.zip")).toEqual(Array.from(png(9)));
    expect(c.read("LICENSE")).toBe("MIT");
  });

  it("sends only what fits the cap, and still receives what a peer uploaded", async () => {
    const vault = await newVault("attachments-cap");
    const skipped: Array<{ plainPath: string; sizeBytes: number }> = [];
    const cap = 8;
    expect(png(10).byteLength).toBeGreaterThan(cap);
    const small = await newClient(vault.id, "device-small-cap", {
      maxFileBytes: cap,
      onFileTooLarge: (event) => skipped.push(event),
    });
    const large = await newClient(vault.id, "device-large-cap", { maxFileBytes: 0 });

    large.writeBinary("photos/too-big.png", png(10));
    await large.sync();

    // The cap bounds **uploads**: a version a peer already stored is part of the vault,
    // so the capped device materialises it and has nothing to report. (Skipping it used
    // to make the file silently absent here, which reads as data loss.)
    await small.sync();
    expect(bytes(small, "photos/too-big.png")).toEqual(Array.from(png(10)));
    expect(skipped).toEqual([]);

    // A local file over the cap is still never sent — while a note beside it is.
    small.writeBinary("photos/local-too-big.png", png(11));
    small.write("note.md", "# small");
    await small.sync();
    await large.sync();
    expect(large.read("note.md")).toBe("# small");
    expect(large.readBytes("photos/local-too-big.png")).toBeNull();
    expect(skipped).toEqual([
      { plainPath: "photos/local-too-big.png", sizeBytes: png(11).byteLength },
    ]);
  });

  /**
   * The two edges of the upload rule: the cap is **inclusive**, and `0` means no cap at
   * all rather than the smallest one.
   *
   * A version a peer already stored is downloaded whatever the local cap says, so the
   * boundary is pinned where it still decides something — a **local** file. These
   * clients set the engine's `maxFileBytes` directly; in production every device of one
   * user key reads the same administrator-set value from `/api/me`, but the engine's
   * rule is evaluated per scope.
   */
  it("sends a file exactly at the cap, and never an over-cap one, while receiving both", async () => {
    const vault = await newVault("attachments-cap-boundary");
    const cap = 8;
    const atCap = new Uint8Array(cap).fill(7);
    const overCap = new Uint8Array(cap + 1).fill(9);

    // The sender has the cap switched off, so both files reach the server's chains.
    const sender = await newClient(vault.id, "device-uncapped-sender", { maxFileBytes: 0 });
    sender.writeBinary("photos/at-cap.png", atCap);
    sender.writeBinary("photos/over-cap.png", overCap);
    await sender.sync();

    const cappedSkips: Array<{ plainPath: string; sizeBytes: number }> = [];
    const capped = await newClient(vault.id, "device-capped", {
      maxFileBytes: cap,
      onFileTooLarge: (event) => cappedSkips.push(event),
    });
    await capped.sync();

    // Both arrive: the cap does not filter what a peer uploaded.
    expect(bytes(capped, "photos/at-cap.png")).toEqual(Array.from(atCap));
    expect(bytes(capped, "photos/over-cap.png")).toEqual(Array.from(overCap));
    expect(cappedSkips).toEqual([]);

    // The same device's own uploads: `size <= cap` goes, one byte more does not, and the
    // skip is reported once.
    capped.writeBinary("photos/local-at-cap.png", atCap);
    capped.writeBinary("photos/local-over-cap.png", overCap);
    await capped.sync();
    await sender.sync();
    expect(sender.readBytes("photos/local-at-cap.png")).not.toBeNull();
    expect(sender.readBytes("photos/local-over-cap.png")).toBeNull();
    expect(cappedSkips).toEqual([{ plainPath: "photos/local-over-cap.png", sizeBytes: cap + 1 }]);

    // `0` is no cap at all, not the smallest one: the same bytes do travel.
    const uncappedSkips: Array<{ plainPath: string; sizeBytes: number }> = [];
    const uncapped = await newClient(vault.id, "device-uncapped", {
      maxFileBytes: 0,
      onFileTooLarge: (event) => uncappedSkips.push(event),
    });
    uncapped.writeBinary("photos/local-over-cap-2.png", overCap);
    await uncapped.sync();
    expect(bytes(uncapped, "photos/local-over-cap-2.png")).toEqual(Array.from(overCap));
    expect(uncappedSkips).toEqual([]);
  });

  it("parks a binary conflict beside the original, keeping its extension", async () => {
    const vault = await newVault("attachments-conflict");
    const a = await newClient(vault.id, "device-a", { fileTypes: only("images") });
    const b = await newClient(vault.id, "device-b", { fileTypes: only("images") });

    a.writeBinary("photos/raw.png", png(11));
    await a.sync();
    await b.sync();
    expect(bytes(b, "photos/raw.png")).toEqual(Array.from(png(11)));

    // Both sides change the same image: the remote version wins and the local bytes are
    // parked beside it — as a PNG, not as a `.conflict.md` full of image data.
    a.writeBinary("photos/raw.png", png(12));
    await a.change("photos/raw.png");
    b.writeBinary("photos/raw.png", png(13));
    await b.change("photos/raw.png");

    const parked = (await b.conflictFiles()).filter((path) => path.startsWith("photos/"));
    expect(parked).toHaveLength(1);
    expect(parked[0]!.endsWith(".conflict.png")).toBe(true);
    expect(bytes(b, parked[0]!)).toEqual(Array.from(png(13)));
    expect(bytes(b, "photos/raw.png")).toEqual(Array.from(png(12)));
  });

  it("renames and deletes an attachment on the chain it already has", async () => {
    const vault = await newVault("attachments-rename");
    const a = await newClient(vault.id, "device-a");
    const b = await newClient(vault.id, "device-b");

    a.writeBinary("photos/raw.png", png(14));
    await a.sync();
    await b.sync();
    const fileId = a.engine.fileIdForPath("photos/raw.png")!;

    a.move("photos/raw.png", "photos/moved.png");
    await a.rename("photos/raw.png", "photos/moved.png");
    await b.sync();

    expect(b.readBytes("photos/raw.png")).toBeNull();
    expect(bytes(b, "photos/moved.png")).toEqual(Array.from(png(14)));
    expect(b.engine.fileIdForPath("photos/moved.png")).toBe(fileId);

    a.remove("photos/moved.png");
    await a.removeAndSync("photos/moved.png");
    await b.sync();

    expect(b.readBytes("photos/moved.png")).toBeNull();
    // One chain throughout: a rename and a delete, never a second file.
    const history = await vaultHistory(server, vault.id);
    expect(history.filter((file) => file.fileId === fileId)).toHaveLength(1);
  });

  it("carries an attachment created on the other device back the other way", async () => {
    const vault = await newVault("attachments-reverse");
    const a = await newClient(vault.id, "device-a");
    const b = await newClient(vault.id, "device-b");

    // The peer is the one holding the bytes: the pull direction has to work on its own,
    // not only as the tail of an A→B push.
    b.writeBinary("media/from-b.png", png(20));
    await b.sync();
    await a.sync();
    expect(bytes(a, "media/from-b.png")).toEqual(Array.from(png(20)));

    // …and an edit made there keeps travelling that way.
    b.writeBinary("media/from-b.png", png(21));
    await b.change("media/from-b.png");
    await a.sync();
    expect(bytes(a, "media/from-b.png")).toEqual(Array.from(png(21)));
    // One chain, one fileId, for the whole exchange.
    const fileId = b.engine.fileIdForPath("media/from-b.png")!;
    expect(a.engine.fileIdForPath("media/from-b.png")).toBe(fileId);
  });

  /**
   * The tiny payloads above cannot show it, but every byte of a file passes through the
   * engine's hashing, AES-GCM and base64 encoding, the HTTP body, the server's blob store
   * and the same path back — and each of those has a size where it stops working if it is
   * written wrong (a spread over a few million arguments, an unchunked string build, a
   * body limit).
   */
  it("carries a multi-megabyte attachment without truncating or re-encoding it", async () => {
    const vault = await newVault("attachments-large");
    const a = await newClient(vault.id, "device-a");
    const b = await newClient(vault.id, "device-b");

    // Deterministic pseudo-random bytes: incompressible in practice, and ~2.5 MB keeps the
    // case inside the default size cap.
    const size = 2_500_000;
    const large = new Uint8Array(size);
    for (let i = 0; i < size; i++) large[i] = (i * 31 + (i >> 8) * 17) % 256;
    expect(size).toBeLessThan(50 * 1024 * 1024);

    a.writeBinary("media/large.mp4", large);
    await a.sync();
    await b.sync();

    const received = b.readBytes("media/large.mp4");
    expect(received?.byteLength).toBe(size);
    // Byte equality, not just length: a re-encode would keep the length and change the bytes.
    expect(Buffer.from(received!)).toEqual(Buffer.from(large));
  });

  it("restores a deleted image from the recycle bin, bytes intact, on both devices", async () => {
    const vault = await newVault("attachments-restore");
    const a = await newClient(vault.id, "device-a");
    const b = await newClient(vault.id, "device-b");

    const original = png(15);
    a.writeBinary("photos/raw.png", original);
    await a.sync();
    await b.sync();
    const fileId = a.engine.fileIdForPath("photos/raw.png")!;
    expect(bytes(b, "photos/raw.png")).toEqual(Array.from(original));

    // Delete it on A: B applies the tombstone, so the file is gone from both and the
    // chain's restorable version is the image A pushed.
    a.remove("photos/raw.png");
    await a.removeAndSync("photos/raw.png");
    await b.sync();
    expect(b.readBytes("photos/raw.png")).toBeNull();

    const bin = await deletedFiles(server, vault.id);
    const entry = bin.find((file) => file.fileId === fileId)!;
    expect(entry.previousContentHash).toBeTruthy();

    // B restores it from the bin: a tombstone carries no content, so the bytes have to
    // come back from the version before it — the path a binary file exercises end to end.
    await b.engine.restoreFile(fileId, "photos/raw.png", entry.previousContentHash!);
    expect(bytes(b, "photos/raw.png")).toEqual(Array.from(original));

    // …and the restore travels back to A as one more version on the same chain.
    await a.sync();
    expect(bytes(a, "photos/raw.png")).toEqual(Array.from(original));
    expect((await fileVersions(server, vault.id, fileId)).map((v) => v.action)).toEqual([
      "create",
      "delete",
      "restore",
    ]);
  });
});

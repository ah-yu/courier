import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { NO_FILE_TYPES } from "../../engine/src/index";
import { createTestClient, type TestClient } from "./harness/client";
import { startTestServer, type TestServer } from "./harness/server";
import {
  createTestVault,
  makeVaultMaterial,
  type TestVault,
  type VaultMaterial,
} from "./harness/vault";
import { fileVersions, filesAtPath } from "./harness/api";

/**
 * Excluded folders end to end: a real server, two real `SyncEngine` instances and a
 * real filesystem.
 *
 * The feature is a device-local scope predicate, so this layer is the one that can
 * prove the two directions together: a file in an excluded folder is neither pushed
 * nor pulled, a peer's chain for it is not touched, and removing the exclusion makes
 * both sides catch up from the state each device already had. The move case is the
 * dangerous one this suite pins: a tracked note moved into an excluded folder must not
 * be read as a deletion of the note every peer still has.
 */

describe("excluded folders e2e", () => {
  let server: TestServer;
  let material: VaultMaterial;
  let clients: TestClient[] = [];

  beforeAll(async () => {
    server = await startTestServer("excluded folders e2e user");
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

  /**
   * A headless client that syncs notes only. Excluded folders are a vault-path rule, so
   * leaving the media types out keeps every case about one decision.
   */
  async function newClient(
    vaultId: string,
    deviceName: string,
    options: { excludedFolders?: readonly string[]; dir?: string } = {},
  ): Promise<TestClient> {
    const client = await createTestClient({
      server,
      vaultId,
      key: material.key,
      deviceName,
      fileTypes: NO_FILE_TYPES,
      ...options,
    });
    clients.push(client);
    return client;
  }

  /**
   * Restart a client over the same directory and the same persisted state.
   *
   * This is what a settings change does on a real host: the engine (and its scope) is
   * rebuilt, while the sync points survive in `sync_state.json` / `data.json`.
   */
  async function reopen(
    previous: TestClient,
    vaultId: string,
    deviceName: string,
    options: { excludedFolders?: readonly string[] } = {},
  ): Promise<TestClient> {
    const next = await newClient(vaultId, deviceName, { ...options, dir: previous.dir });
    next.engine.loadState(previous.state.json ?? "{}");
    return next;
  }

  it("keeps an excluded folder on the device that excludes it, in both directions", async () => {
    const vault = await newVault("excluded-basic");
    const a = await newClient(vault.id, "device-a", { excludedFolders: ["private"] });
    const b = await newClient(vault.id, "device-b");

    a.write("public.md", "a-public");
    a.write("private/a.md", "a-private");
    b.write("public-b.md", "b-public");
    b.write("private/b.md", "b-private");

    await a.sync();
    await b.sync();
    await a.sync();

    // A's excluded note never left; B's excluded note never arrived.
    expect(await filesAtPath(server, vault.id, material.key, "private/a.md")).toEqual([]);
    expect(await filesAtPath(server, vault.id, material.key, "private/b.md")).toHaveLength(1);
    expect(a.read("private/b.md")).toBeNull();
    expect(b.read("private/a.md")).toBeNull();

    // Everything outside the folder still travels normally, and nothing was parked.
    expect(b.read("public.md")).toBe("a-public");
    expect(a.read("public-b.md")).toBe("b-public");
    expect(await a.conflictFiles()).toEqual([]);
    expect(await b.conflictFiles()).toEqual([]);
  });

  it("resumes both directions when the exclusion is removed", async () => {
    const vault = await newVault("excluded-resume");
    const a = await newClient(vault.id, "device-a", { excludedFolders: ["private"] });
    const b = await newClient(vault.id, "device-b");

    a.write("private/a.md", "a-private");
    b.write("private/b.md", "b-private");
    await a.sync();
    await b.sync();
    await a.sync();
    expect(await filesAtPath(server, vault.id, material.key, "private/a.md")).toEqual([]);
    expect(a.read("private/b.md")).toBeNull();

    // The same directory and state, with the folder back in scope: the bind pushes the
    // local note and pulls the peer's, exactly like any other untracked/remote pair.
    const resumed = await reopen(a, vault.id, "device-a");
    await resumed.sync();

    expect(await filesAtPath(server, vault.id, material.key, "private/a.md")).toHaveLength(1);
    expect(resumed.read("private/b.md")).toBe("b-private");
    await b.sync();
    expect(b.read("private/a.md")).toBe("a-private");
  });

  it("does not push a tombstone when a tracked note is moved into an excluded folder", async () => {
    const vault = await newVault("excluded-move");
    const a = await newClient(vault.id, "device-a");
    const b = await newClient(vault.id, "device-b");
    a.write("note.md", "body");
    await a.sync();
    await b.sync();
    expect(b.read("note.md")).toBe("body");

    // Restart A with the folder excluded, keeping its sync state: the chain is tracked
    // and now records a path the engine is not allowed to sync.
    const excluded = await reopen(a, vault.id, "device-a", { excludedFolders: ["private"] });
    const fileId = excluded.engine.fileIdForPath("note.md")!;
    excluded.move("note.md", "private/note.md");
    await excluded.rename("note.md", "private/note.md");
    await excluded.sync();

    // A rename event, not a deletion: the chain still ends at the create version.
    expect((await fileVersions(server, vault.id, fileId)).map((version) => version.action)).toEqual(
      ["create"],
    );
    expect(excluded.engine.fileIdForPath("private/note.md")).toBe(fileId);
    await b.sync();
    expect(b.read("note.md")).toBe("body");
    expect(b.read("private/note.md")).toBeNull();

    // Back in scope, the recorded path disagrees with the remote head's path: the move
    // is pushed as a rename on the same chain and the peer follows it.
    const resumed = await reopen(excluded, vault.id, "device-a");
    await resumed.sync();
    expect((await fileVersions(server, vault.id, fileId)).at(-1)?.action).toBe("rename");
    await b.sync();
    expect(b.read("note.md")).toBeNull();
    expect(b.read("private/note.md")).toBe("body");
  });

  /**
   * The same move, but the host delivers no rename: an external tool or a stopped daemon
   * shows the engine only "the old path is gone", and the new path is filtered out by the
   * scope. The engine has to find the file under the excluded folder and record the move
   * instead of publishing a deletion of a note every peer still has.
   */
  it("recognises a note moved into an excluded folder without a rename event", async () => {
    const vault = await newVault("excluded-eventless-move");
    const a = await newClient(vault.id, "device-a");
    const b = await newClient(vault.id, "device-b");
    a.write("note.md", "body");
    await a.sync();
    await b.sync();
    expect(b.read("note.md")).toBe("body");

    const excluded = await reopen(a, vault.id, "device-a", { excludedFolders: ["private"] });
    const fileId = excluded.engine.fileIdForPath("note.md")!;
    // Disk changes only. `bind()` is what a host start does after the move; the delete
    // event variant is exercised in the next case.
    excluded.move("note.md", "private/note.md");
    await excluded.bind();
    await excluded.sync();

    expect((await fileVersions(server, vault.id, fileId)).map((version) => version.action)).toEqual(
      ["create"],
    );
    expect(excluded.engine.fileIdForPath("private/note.md")).toBe(fileId);
    await b.sync();
    expect(b.read("note.md")).toBe("body");

    // Still one chain when the folder comes back into scope: the recorded path is the
    // move the engine inferred, so it is pushed as a rename.
    const resumed = await reopen(excluded, vault.id, "device-a");
    await resumed.sync();
    expect((await fileVersions(server, vault.id, fileId)).at(-1)?.action).toBe("rename");
    await b.sync();
    expect(b.read("note.md")).toBeNull();
    expect(b.read("private/note.md")).toBe("body");
  });

  it("recognises the move from a bare delete event, as the CLI's watcher reports it", async () => {
    const vault = await newVault("excluded-eventless-delete");
    const a = await newClient(vault.id, "device-a");
    a.write("note.md", "body");
    await a.sync();
    const fileId = a.engine.fileIdForPath("note.md")!;

    const excluded = await reopen(a, vault.id, "device-a", { excludedFolders: ["private"] });
    excluded.move("note.md", "private/note.md");
    await excluded.removeAndSync("note.md");

    expect((await fileVersions(server, vault.id, fileId)).map((version) => version.action)).toEqual(
      ["create"],
    );
    expect(excluded.engine.fileIdForPath("private/note.md")).toBe(fileId);
  });

  it("ignores a peer's edit and deletion while excluded, then applies them once resumed", async () => {
    const vault = await newVault("excluded-remote-changes");
    const a = await newClient(vault.id, "device-a");
    const b = await newClient(vault.id, "device-b");
    a.write("private/edit.md", "local-edit");
    a.write("private/gone.md", "local-gone");
    await a.sync();
    await b.sync();

    const excluded = await reopen(a, vault.id, "device-a", { excludedFolders: ["private"] });
    b.write("private/edit.md", "remote-edit");
    b.remove("private/gone.md");
    await b.sync();
    await excluded.sync();
    // Nothing the peer did reached the excluded folder.
    expect(excluded.read("private/edit.md")).toBe("local-edit");
    expect(excluded.read("private/gone.md")).toBe("local-gone");

    // With the folder back in scope, the normal rules apply: the untouched remote edit
    // is pulled, and the remote tombstone removes the file exactly as it would have.
    const resumed = await reopen(excluded, vault.id, "device-a");
    await resumed.sync();
    expect(resumed.read("private/edit.md")).toBe("remote-edit");
    expect(resumed.read("private/gone.md")).toBeNull();
  });
});

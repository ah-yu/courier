import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { App, PluginManifest } from "obsidian";
import CourierPlugin from "../../plugin/src/main";
import { DEFAULT_SETTINGS } from "../../plugin/src/shared/settings";
import { isConflictFile } from "../../engine/src/index";
import { Platform, resetStubState } from "./harness/obsidian-stub";
import { FakeVault } from "./harness/fake-vault";
import { createFakeApp } from "./harness/fake-app";
import { installFetchTransport, resetRecordedRequests } from "./harness/plugin-transport";
import { startTestServer, type TestServer } from "./harness/server";
import {
  createTestVault,
  makeVaultMaterial,
  type TestVault,
  type VaultMaterial,
} from "./harness/vault";
import { createTestClient, type TestClient } from "./harness/client";
import { deletedFiles, fileVersions, filesAtPath } from "./harness/api";
import { waitFor, waitForAsync } from "./harness/wait";

/**
 * Plugin-level end-to-end for **folder operations**, in both directions: a rename,
 * a move into another folder, a delete, and the notes inside them.
 *
 * None of these is one event. Obsidian renames (or deletes) the folder and every
 * descendant with it, and reports it as a burst: the `TFolder` event first, then one
 * per descendant file, breadth first for a rename and in no defined order for a
 * delete. `EngineHost` drops the folder events on purpose (`"extension" in file`), so
 * every note inside has to reach the server through its own child event — and the
 * peer has to materialise the whole subtree, in a folder it may not have yet.
 *
 * That burst is the interesting shape, and none of the other suites covers it:
 * `path-sync.e2e.test.ts` pins path shapes at L1 (one file per operation, no vault
 * events) and the rename cases in `plugin.e2e.test.ts` are root level, so "move a
 * tree", "a note deep inside a tree moves" and "two notes arrive in one new folder"
 * had no coverage at all.
 *
 * The layer is L2 on purpose: what is under test is the host's event wiring (a folder
 * event must be ignored, each child event must be handled) plus the engine's ability
 * to move or write a note into a folder the vault does not have yet. The same bursts
 * run against a real Obsidian in `src/obsidian/sync.obsidian.test.ts`.
 */

const MANIFEST = {
  id: "courier",
  name: "Courier",
  version: "0.0.0",
  minAppVersion: "1.0.0",
  author: "Courier",
  description: "e2e manifest",
} satisfies PluginManifest;

interface HostedPlugin {
  plugin: CourierPlugin;
  vault: FakeVault;
  remote: TestVault;
}

/**
 * Rename a folder on a headless client, the way Obsidian does it: every file
 * under it moves, and each move is reported as its own rename.
 */
async function renameFolderOnPeer(peer: TestClient, from: string, to: string): Promise<void> {
  const inside = (await peer.list()).filter((path) => path.startsWith(`${from}/`));
  expect(inside.length, `no file under ${from} to move`).toBeGreaterThan(0);
  for (const path of inside) {
    const target = `${to}${path.slice(from.length)}`;
    peer.move(path, target);
    await peer.rename(path, target);
  }
}

/** Every path the vault holds, conflict copies included (there must be none). */
function vaultPaths(vault: FakeVault): string[] {
  // `.courier/sync-lease` is supervisor state, like `.obsidian`; it is outside sync and
  // must not be counted as a note.
  return vault.paths().filter((path) => !path.startsWith(".courier/"));
}

function conflictPaths(vault: FakeVault): string[] {
  return vault.paths().filter((path) => isConflictFile(path));
}

/** The peer's files, as a sorted list. */
async function peerPaths(peer: TestClient): Promise<string[]> {
  return (await peer.list()).toSorted();
}

describe("plugin e2e — folder renames across two devices", () => {
  let server: TestServer;
  let material: VaultMaterial;
  let plugins: CourierPlugin[] = [];
  let peers: TestClient[] = [];

  beforeAll(async () => {
    server = await startTestServer("folder rename e2e user");
    material = await makeVaultMaterial();
  }, 120_000);

  beforeEach(() => {
    resetRecordedRequests();
    resetStubState();
    installFetchTransport();
    Platform.isDesktop = true;
    Platform.isMobile = false;
  });

  afterEach(() => {
    for (const plugin of plugins) plugin.onunload();
    plugins = [];
    for (const peer of peers) peer.cleanup();
    peers = [];
  });

  afterAll(async () => {
    await server.close();
  });

  /** Load the plugin bound to a fresh vault and start its sync host. */
  async function startHostedPlugin(
    vaultName: string,
    seed: (vault: FakeVault) => Promise<void>,
  ): Promise<HostedPlugin> {
    const vault = new FakeVault();
    await seed(vault);
    const remote = await createTestVault(server, vaultName, material);
    const app = createFakeApp(vault);
    const plugin = new CourierPlugin(app as unknown as App, MANIFEST);
    await plugin.saveData({
      ...DEFAULT_SETTINGS,
      serverUrl: server.serverUrl,
      userKey: server.userKey,
      connectedVaultId: remote.id,
      connectedVaultName: remote.name,
    });
    await plugin.onload();
    plugins.push(plugin);
    plugin.encryptionKey = material.key;
    await plugin.startHost();
    return { plugin, vault, remote };
  }

  async function newPeer(vaultId: string, deviceName = "peer"): Promise<TestClient> {
    const peer = await createTestClient({ server, vaultId, key: material.key, deviceName });
    peers.push(peer);
    return peer;
  }

  /**
   * Wait until both ends agree on `paths`, each holding its own bytes.
   *
   * A folder rename is a burst of independent pushes, so "the peer has the first
   * note at its new path" is not the same moment as "the last one arrived" —
   * asserting between those two moments is how a suite becomes flaky.
   */
  async function waitForPaths(
    vault: FakeVault,
    peer: TestClient,
    paths: string[],
    contents: Record<string, string>,
  ): Promise<void> {
    await waitForAsync(
      async () => {
        const theirs = await peerPaths(peer);
        return (
          paths.every((path) => vault.has(path) && theirs.includes(path)) &&
          paths.every((path) => peer.read(path) === contents[path]) &&
          theirs.length === paths.length
        );
      },
      `both devices never converged on ${paths.join(", ")} (vault: ${vaultPaths(vault).join(", ")} | peer: ${(await peerPaths(peer)).join(", ")})`,
    );
  }

  /**
   * Wait until the server's live path is `path` for exactly one chain.
   *
   * The plugin pushes from vault event handlers (fire and forget), so the vault's
   * own bytes are right before the server knows — asserting on the peer straight
   * after `settle()` would race those pushes.
   */
  async function waitForServerPaths(vaultId: string, paths: string[]): Promise<void> {
    await waitForAsync(
      async () => {
        for (const path of paths) {
          if ((await filesAtPath(server, vaultId, material.key, path)).length !== 1) return false;
        }
        return true;
      },
      `the server never recorded ${paths.join(", ")} as the only chain at those paths`,
    );
  }

  /** One chain per path, and nothing else on the server. */
  async function expectOneChainPerPath(
    vaultId: string,
    paths: string[],
    fileIds: Map<string, string>,
  ): Promise<void> {
    for (const path of paths) {
      expect(await filesAtPath(server, vaultId, material.key, path)).toEqual([fileIds.get(path)!]);
    }
  }

  it("follows a rename of the deepest folder, moving every note inside it", async () => {
    const { plugin, vault, remote } = await startHostedPlugin(
      "Deepest Folder Rename",
      async (v) => {
        await v.create("projects/alpha/deep/one.md", "one");
        await v.create("projects/alpha/deep/two.md", "two");
        await v.create("projects/alpha/top.md", "top");
      },
    );
    const fileIds = new Map<string, string>();
    await waitFor(() => plugin.engine!.fileIdForPath("projects/alpha/deep/one.md") != null, "bind");
    for (const path of [
      "projects/alpha/deep/one.md",
      "projects/alpha/deep/two.md",
      "projects/alpha/top.md",
    ]) {
      fileIds.set(path, plugin.engine!.fileIdForPath(path)!);
    }

    const peer = await newPeer(remote.id);
    await peer.sync();
    await waitFor(
      () => vaultPaths(vault).length === 3,
      `the vault lost a note while binding: ${vaultPaths(vault).join(", ")}`,
    );

    // The deepest folder, the one whose notes are furthest from the root.
    await vault.renameFolder("projects/alpha/deep", "projects/alpha/archive");
    await vault.settle();

    const moved = ["projects/alpha/archive/one.md", "projects/alpha/archive/two.md"];
    await waitForServerPaths(remote.id, [...moved, "projects/alpha/top.md"]);
    await peer.sync();
    await waitForPaths(vault, peer, [...moved, "projects/alpha/top.md"], {
      "projects/alpha/archive/one.md": "one",
      "projects/alpha/archive/two.md": "two",
      "projects/alpha/top.md": "top",
    });

    expect(vaultPaths(vault).toSorted()).toEqual(
      [
        "projects/alpha/archive/one.md",
        "projects/alpha/archive/two.md",
        "projects/alpha/top.md",
      ].toSorted(),
    );
    expect(conflictPaths(vault)).toEqual([]);
    expect(peer.read("projects/alpha/deep/one.md")).toBeNull();
    expect(fileIds.get("projects/alpha/deep/one.md")).not.toBeUndefined();
    await expectOneChainPerPath(
      remote.id,
      ["projects/alpha/archive/one.md", "projects/alpha/archive/two.md", "projects/alpha/top.md"],
      new Map([
        ["projects/alpha/archive/one.md", fileIds.get("projects/alpha/deep/one.md")!],
        ["projects/alpha/archive/two.md", fileIds.get("projects/alpha/deep/two.md")!],
        ["projects/alpha/top.md", fileIds.get("projects/alpha/top.md")!],
      ]),
    );
  });

  it("follows a rename of a note inside the deepest folder", async () => {
    const { plugin, vault, remote } = await startHostedPlugin("Deep Note Rename", async (v) => {
      await v.create("projects/alpha/deep/one.md", "one");
      await v.create("projects/alpha/deep/two.md", "two");
    });
    await waitFor(() => plugin.engine!.fileIdForPath("projects/alpha/deep/one.md") != null, "bind");
    const fileId = plugin.engine!.fileIdForPath("projects/alpha/deep/one.md")!;

    const peer = await newPeer(remote.id);
    await peer.sync();
    await waitForPaths(vault, peer, ["projects/alpha/deep/one.md", "projects/alpha/deep/two.md"], {
      "projects/alpha/deep/one.md": "one",
      "projects/alpha/deep/two.md": "two",
    });

    await vault.move("projects/alpha/deep/one.md", "projects/alpha/deep/renamed.md");
    await vault.settle();

    await waitForServerPaths(remote.id, ["projects/alpha/deep/renamed.md"]);
    await peer.sync();
    await waitForPaths(
      vault,
      peer,
      ["projects/alpha/deep/renamed.md", "projects/alpha/deep/two.md"],
      {
        "projects/alpha/deep/renamed.md": "one",
        "projects/alpha/deep/two.md": "two",
      },
    );

    expect(plugin.engine!.fileIdForPath("projects/alpha/deep/renamed.md")).toBe(fileId);
    expect(peer.read("projects/alpha/deep/one.md")).toBeNull();
    expect(
      await filesAtPath(server, remote.id, material.key, "projects/alpha/deep/renamed.md"),
    ).toEqual([fileId]);
    expect(
      await filesAtPath(server, remote.id, material.key, "projects/alpha/deep/one.md"),
    ).toEqual([]);
  });

  it("follows a rename of a folder that is not the deepest one", async () => {
    const { plugin, vault, remote } = await startHostedPlugin("Outer Folder Rename", async (v) => {
      await v.create("projects/alpha/deep/one.md", "one");
      await v.create("projects/alpha/deep/more/two.md", "two");
      await v.create("projects/alpha/top.md", "top");
    });
    await waitFor(() => plugin.engine!.fileIdForPath("projects/alpha/deep/one.md") != null, "bind");
    const oneId = plugin.engine!.fileIdForPath("projects/alpha/deep/one.md")!;
    const twoId = plugin.engine!.fileIdForPath("projects/alpha/deep/more/two.md")!;
    const topId = plugin.engine!.fileIdForPath("projects/alpha/top.md")!;

    const peer = await newPeer(remote.id);
    await peer.sync();

    // A middle folder: it has a nested folder of its own, so its children change
    // path at three different depths.
    await vault.renameFolder("projects/alpha", "projects/beta");
    await vault.settle();

    const moved = [
      "projects/beta/deep/one.md",
      "projects/beta/deep/more/two.md",
      "projects/beta/top.md",
    ];
    await waitForServerPaths(remote.id, moved);
    await peer.sync();
    await waitForPaths(vault, peer, moved, {
      "projects/beta/deep/one.md": "one",
      "projects/beta/deep/more/two.md": "two",
      "projects/beta/top.md": "top",
    });

    expect(vaultPaths(vault).toSorted()).toEqual(moved.toSorted());
    expect(conflictPaths(vault)).toEqual([]);
    await expectOneChainPerPath(
      remote.id,
      moved,
      new Map([
        ["projects/beta/deep/one.md", oneId],
        ["projects/beta/deep/more/two.md", twoId],
        ["projects/beta/top.md", topId],
      ]),
    );
  });

  it("follows a rename of a note in a folder that is not the deepest one", async () => {
    const { plugin, vault, remote } = await startHostedPlugin("Outer Note Rename", async (v) => {
      await v.create("projects/alpha/top.md", "top");
      await v.create("projects/alpha/deep/one.md", "one");
    });
    await waitFor(() => plugin.engine!.fileIdForPath("projects/alpha/top.md") != null, "bind");
    const fileId = plugin.engine!.fileIdForPath("projects/alpha/top.md")!;

    const peer = await newPeer(remote.id);
    await peer.sync();
    await waitForPaths(vault, peer, ["projects/alpha/top.md", "projects/alpha/deep/one.md"], {
      "projects/alpha/top.md": "top",
      "projects/alpha/deep/one.md": "one",
    });

    await vault.move("projects/alpha/top.md", "projects/alpha/renamed.md");
    await vault.settle();

    await waitForServerPaths(remote.id, ["projects/alpha/renamed.md"]);
    await peer.sync();
    await waitForPaths(vault, peer, ["projects/alpha/renamed.md", "projects/alpha/deep/one.md"], {
      "projects/alpha/renamed.md": "top",
      "projects/alpha/deep/one.md": "one",
    });
    expect(plugin.engine!.fileIdForPath("projects/alpha/renamed.md")).toBe(fileId);
    expect(peer.read("projects/alpha/top.md")).toBeNull();
  });

  it("moves its own notes when a peer renames the folder they live in", async () => {
    const { plugin, vault, remote } = await startHostedPlugin("Peer Folder Rename", async (v) => {
      await v.create("projects/alpha/deep/one.md", "one");
      await v.create("projects/alpha/deep/more/two.md", "two");
    });
    await waitFor(() => plugin.engine!.fileIdForPath("projects/alpha/deep/one.md") != null, "bind");

    const peer = await newPeer(remote.id);
    await peer.sync();
    await waitForPaths(
      vault,
      peer,
      ["projects/alpha/deep/one.md", "projects/alpha/deep/more/two.md"],
      {
        "projects/alpha/deep/one.md": "one",
        "projects/alpha/deep/more/two.md": "two",
      },
    );

    // The peer moves the tree; the plugin has to materialise the new folder chain
    // (it has never seen `projects/beta`) and leave the old paths empty.
    await renameFolderOnPeer(peer, "projects/alpha/deep", "projects/beta/deep");
    await plugin.host!.engine!.initialSync();

    await waitForPaths(
      vault,
      peer,
      ["projects/beta/deep/one.md", "projects/beta/deep/more/two.md"],
      {
        "projects/beta/deep/one.md": "one",
        "projects/beta/deep/more/two.md": "two",
      },
    );
    expect(conflictPaths(vault)).toEqual([]);
    expect(vaultPaths(vault).toSorted()).toEqual(
      ["projects/beta/deep/one.md", "projects/beta/deep/more/two.md"].toSorted(),
    );
  });

  /**
   * The follower's worst shape, and the one the app really produces: the peer
   * moves every file in one burst, so the notifications reach the host back to
   * back and are handled **concurrently** (`runInBackground`, one promise per
   * event — nothing serialises them). Both moves need the same folder that does
   * not exist yet, and every note is empty, so the chains also share one content
   * hash. No reconcile is allowed here: the notifications alone must converge.
   */
  it("follows a peer's folder rename delivered as a concurrent notification burst", async () => {
    const { plugin, vault, remote } = await startHostedPlugin("Peer Folder Burst", async (v) => {
      await v.create("projects/alpha/deep/one.md", "");
      await v.create("projects/alpha/deep/two.md", "");
    });
    await waitFor(() => plugin.engine!.fileIdForPath("projects/alpha/deep/one.md") != null, "bind");
    const oneId = plugin.engine!.fileIdForPath("projects/alpha/deep/one.md")!;
    const twoId = plugin.engine!.fileIdForPath("projects/alpha/deep/two.md")!;

    const peer = await newPeer(remote.id);
    await peer.sync();
    await waitForPaths(vault, peer, ["projects/alpha/deep/one.md", "projects/alpha/deep/two.md"], {
      "projects/alpha/deep/one.md": "",
      "projects/alpha/deep/two.md": "",
    });

    // Move both files, then push both renames without waiting in between: that is
    // how the two notifications leave the peer, and how they arrive here.
    const sources = ["projects/alpha/deep/one.md", "projects/alpha/deep/two.md"];
    const targets = ["projects/beta/deep/one.md", "projects/beta/deep/two.md"];
    sources.forEach((from, index) => peer.move(from, targets[index]!));
    await Promise.all(sources.map((from, index) => peer.rename(from, targets[index]!)));

    await waitForPaths(vault, peer, targets, {
      "projects/beta/deep/one.md": "",
      "projects/beta/deep/two.md": "",
    });
    expect(conflictPaths(vault)).toEqual([]);
    expect(plugin.engine!.fileIdForPath("projects/beta/deep/one.md")).toBe(oneId);
    expect(plugin.engine!.fileIdForPath("projects/beta/deep/two.md")).toBe(twoId);
    await expectOneChainPerPath(
      remote.id,
      targets,
      new Map([
        ["projects/beta/deep/one.md", oneId],
        ["projects/beta/deep/two.md", twoId],
      ]),
    );
  });

  it("materialises notes a peer created together in a folder this vault does not have", async () => {
    const { vault, remote } = await startHostedPlugin("Peer New Folder Burst", async () => {});
    const peer = await newPeer(remote.id);
    await peer.bind();

    // Two notes in one folder this vault has never had, pushed together: both writes
    // need the folder, so this is the same folder-creation race as a folder rename —
    // on the `createBinary` path instead of the `rename` one.
    peer.write("shared/deep/one.md", "one");
    peer.write("shared/deep/two.md", "two");
    await Promise.all([peer.change("shared/deep/one.md"), peer.change("shared/deep/two.md")]);

    const paths = ["shared/deep/one.md", "shared/deep/two.md"];
    await waitForPaths(vault, peer, paths, {
      "shared/deep/one.md": "one",
      "shared/deep/two.md": "two",
    });
    expect(conflictPaths(vault)).toEqual([]);
  });

  it("moves a folder into another folder, notes and all", async () => {
    const { plugin, vault, remote } = await startHostedPlugin("Folder Into Folder", async (v) => {
      await v.create("projects/alpha/one.md", "one");
      await v.create("projects/alpha/deep/two.md", "two");
      await v.create("archive/keep.md", "keep");
    });
    await waitFor(() => plugin.engine!.fileIdForPath("projects/alpha/one.md") != null, "bind");
    const oneId = plugin.engine!.fileIdForPath("projects/alpha/one.md")!;
    const twoId = plugin.engine!.fileIdForPath("projects/alpha/deep/two.md")!;

    const peer = await newPeer(remote.id);
    await peer.sync();

    // The move the file explorer's drag-and-drop makes: the folder keeps its name
    // and gains a parent, so **every** descendant's path changes at once.
    await vault.renameFolder("projects/alpha", "archive/projects/alpha");
    await vault.settle();

    const moved = ["archive/projects/alpha/one.md", "archive/projects/alpha/deep/two.md"];
    await waitForServerPaths(remote.id, moved);
    await peer.sync();
    await waitForPaths(vault, peer, [...moved, "archive/keep.md"], {
      "archive/projects/alpha/one.md": "one",
      "archive/projects/alpha/deep/two.md": "two",
      "archive/keep.md": "keep",
    });

    expect(vaultPaths(vault).toSorted()).toEqual([...moved, "archive/keep.md"].toSorted());
    expect(conflictPaths(vault)).toEqual([]);
    await expectOneChainPerPath(
      remote.id,
      moved,
      new Map([
        ["archive/projects/alpha/one.md", oneId],
        ["archive/projects/alpha/deep/two.md", twoId],
      ]),
    );
  });

  it("deletes every note when the folder holding them is deleted", async () => {
    const { plugin, vault, remote } = await startHostedPlugin("Folder Delete", async (v) => {
      await v.create("projects/alpha/one.md", "one");
      await v.create("projects/alpha/deep/two.md", "two");
      await v.create("projects/keep.md", "keep");
    });
    await waitFor(() => plugin.engine!.fileIdForPath("projects/alpha/one.md") != null, "bind");

    const peer = await newPeer(remote.id);
    await peer.sync();
    await waitForPaths(
      vault,
      peer,
      ["projects/alpha/one.md", "projects/alpha/deep/two.md", "projects/keep.md"],
      {
        "projects/alpha/one.md": "one",
        "projects/alpha/deep/two.md": "two",
        "projects/keep.md": "keep",
      },
    );

    // A folder delete is the other burst Obsidian sends — the folder and every
    // descendant, in no particular order — and the folder events are dropped like
    // the rename ones, so each note has to be tombstoned by its own event.
    await vault.deleteFolder("projects/alpha");
    await vault.settle();

    // Both notes reached the recycle bin on the server's side …
    await waitForAsync(
      async () => (await deletedFiles(server, remote.id)).length >= 2,
      "the folder's notes never reached the server as deletions",
    );
    expect(vaultPaths(vault)).toEqual(["projects/keep.md"]);

    // … and the peer applies them.
    await peer.sync();
    expect(await peerPaths(peer)).toEqual(["projects/keep.md"]);
    expect(peer.read("projects/alpha/one.md")).toBeNull();
    expect(peer.read("projects/alpha/deep/two.md")).toBeNull();
    expect(peer.read("projects/keep.md")).toBe("keep");
  });

  it("catches up a folder rename made while the connection was down", async () => {
    const { plugin, vault, remote } = await startHostedPlugin(
      "Offline Folder Rename",
      async (v) => {
        await v.create("projects/alpha/deep/one.md", "one");
        await v.create("projects/alpha/deep/two.md", "two");
      },
    );
    await waitFor(() => plugin.engine!.fileIdForPath("projects/alpha/deep/one.md") != null, "bind");

    const peer = await newPeer(remote.id);
    await peer.sync();

    // Every child push fails while the plugin is offline, so the moves only reach
    // the server through the reconcile a reconnect runs — the host's own record has
    // to survive the burst either way, or the next pass reads it as delete + create.
    plugin.settings.serverUrl = "http://127.0.0.1:1";
    await vault.renameFolder("projects/alpha/deep", "projects/alpha/archive");
    await vault.settle();
    plugin.settings.serverUrl = server.serverUrl;
    await plugin.host!.engine!.initialSync();
    await vault.settle();

    const moved = ["projects/alpha/archive/one.md", "projects/alpha/archive/two.md"];
    await waitForServerPaths(remote.id, moved);
    await peer.sync();
    await waitForPaths(vault, peer, moved, {
      "projects/alpha/archive/one.md": "one",
      "projects/alpha/archive/two.md": "two",
    });
    expect(vaultPaths(vault).toSorted()).toEqual(moved.toSorted());
    expect(conflictPaths(vault)).toEqual([]);
  });

  it("materialises a folder rename a peer never saw at the new paths only", async () => {
    const { plugin, vault, remote } = await startHostedPlugin(
      "Folder Rename Before Pull",
      async (v) => {
        await v.create("projects/alpha/deep/one.md", "one");
        await v.create("projects/alpha/deep/more/two.md", "two");
      },
    );
    await waitFor(() => plugin.engine!.fileIdForPath("projects/alpha/deep/one.md") != null, "bind");

    await vault.renameFolder("projects/alpha/deep", "projects/beta/deep");
    await vault.settle();
    await waitForServerPaths(remote.id, [
      "projects/beta/deep/one.md",
      "projects/beta/deep/more/two.md",
    ]);

    // A device that never saw the old paths binds afterwards: one file per path, at
    // the new ones.
    const peer = await newPeer(remote.id);
    await peer.bind();

    const moved = ["projects/beta/deep/one.md", "projects/beta/deep/more/two.md"];
    expect(await peerPaths(peer)).toEqual(moved.toSorted());
    expect(peer.read("projects/beta/deep/one.md")).toBe("one");
    expect(peer.read("projects/beta/deep/more/two.md")).toBe("two");
    expect(await peer.conflictFiles()).toEqual([]);
    expect(
      (
        await fileVersions(
          server,
          remote.id,
          plugin.engine!.fileIdForPath("projects/beta/deep/one.md")!,
        )
      ).at(-1)?.action,
    ).toBe("rename");
  });
});

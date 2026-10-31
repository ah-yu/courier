import { describe, expect, it } from "vitest";
import { setLocale } from "../i18n";
import {
  SYNC_STATUSES,
  statusIcon,
  statusLabel,
  statusTooltip,
  syncStatusOf,
  type SyncStatusInput,
} from "./sync-status";

/** A bound, running, connected host — the healthy baseline each case changes one field of. */
function input(overrides: Partial<SyncStatusInput> = {}): SyncStatusInput {
  return {
    connectedVaultId: "vault-1",
    userKey: "ck_test",
    syncPaused: false,
    hostRunning: true,
    wsState: "connected",
    ...overrides,
  };
}

/**
 * The status bar is the one always-visible claim the plugin makes, so the mapping is
 * pinned here instead of being spread through the menu and the CSS class names.
 */
describe("syncStatusOf", () => {
  it("answers syncing only for a running host whose socket is subscribed", () => {
    expect(syncStatusOf(input())).toBe("syncing");
  });

  it("answers paused for a bound vault, whatever the host is doing", () => {
    expect(syncStatusOf(input({ syncPaused: true }))).toBe("paused");
    expect(syncStatusOf(input({ syncPaused: true, hostRunning: false }))).toBe("paused");
    expect(syncStatusOf(input({ syncPaused: true, wsState: "error" }))).toBe("paused");
  });

  it("answers not-connected before it answers paused", () => {
    // A stale pause flag cannot make the icon claim a vault this device is not bound to.
    expect(syncStatusOf(input({ connectedVaultId: null, syncPaused: true }))).toBe("not-connected");
    expect(syncStatusOf(input({ userKey: null, syncPaused: true }))).toBe("not-connected");
    expect(syncStatusOf(input({ connectedVaultId: null, userKey: null }))).toBe("not-connected");
  });

  it("answers not-synced for every bound state without a live host", () => {
    for (const wsState of ["connecting", "error", "disconnected"]) {
      expect(syncStatusOf(input({ wsState })), wsState).toBe("not-synced");
    }
    expect(syncStatusOf(input({ hostRunning: false }))).toBe("not-synced");
  });

  it("answers waiting while the CLI owns the vault lease", () => {
    expect(syncStatusOf(input({ leaseWaiting: true }))).toBe("waiting");
    // Paused still wins: the user deliberately stopped this host.
    expect(syncStatusOf(input({ leaseWaiting: true, syncPaused: true }))).toBe("paused");
  });

  it("counts a bind pass as syncing, even though it has no socket yet", () => {
    // The first pass runs before the socket subscribes; without this a fresh connect of a
    // large vault showed the "something is wrong" icon for its whole duration.
    expect(syncStatusOf(input({ wsState: "disconnected", binding: true }))).toBe("syncing");
    // A stopped host is not syncing, whatever the last pass reported.
    expect(
      syncStatusOf(input({ wsState: "disconnected", binding: true, hostRunning: false })),
    ).toBe("not-synced");
    // Paused and the lease wait still win over a running bind.
    expect(syncStatusOf(input({ wsState: "disconnected", binding: true, syncPaused: true }))).toBe(
      "paused",
    );
    expect(
      syncStatusOf(input({ wsState: "disconnected", binding: true, leaseWaiting: true })),
    ).toBe("waiting");
  });
});

describe("status icons and labels", () => {
  it("gives every status its own icon", () => {
    const icons = SYNC_STATUSES.map((status) => statusIcon(status));
    expect(new Set(icons).size).toBe(icons.length);
    expect(icons).toEqual(["cloud-off", "circle-slash", "refresh-cw", "lock", "pause"]);
  });

  it("has a label for every status in both catalogs", () => {
    setLocale("zh");
    expect(SYNC_STATUSES.map((status) => statusLabel(status))).toEqual([
      "未连接",
      "未同步",
      "正在同步",
      "外部同步服务正在同步",
      "暂停同步",
    ]);
    setLocale("en");
    expect(SYNC_STATUSES.map((status) => statusLabel(status))).toEqual([
      "Not connected",
      "Not syncing",
      "Syncing",
      "External sync service is syncing",
      "Sync paused",
    ]);
  });
});

/**
 * The tooltip is the only place the icon's state becomes words: the element itself is
 * icon-only (docs/plugin.md), and Obsidian shows the `aria-label` on hover. The counter
 * has to appear for a first pass and disappear the moment it finishes, or the icon claims
 * a "first sync" that is long over.
 */
describe("statusTooltip", () => {
  const progress = { done: 1_200, total: 10_000 };

  it("names the state, and the vault when there is one", () => {
    expect(statusTooltip("syncing", null, null)).toBe("Courier: Syncing");
    expect(statusTooltip("not-synced", "Notes", null)).toBe('Courier: Not syncing in "Notes"');
    // Every state gets its catalog text, in the active locale.
    setLocale("zh");
    expect(statusTooltip("not-connected", null, null)).toBe("Courier：未连接");
    expect(statusTooltip("paused", "笔记", null)).toBe("Courier：暂停同步「笔记」");
    setLocale("en");
  });

  it("carries the first pass's counter while the pass is still running", () => {
    expect(statusTooltip("syncing", null, progress)).toBe(
      "Courier: first sync — 1200 of 10000 files",
    );
    expect(statusTooltip("syncing", "Notes", progress)).toBe(
      'Courier: first sync — 1200 of 10000 files in "Notes"',
    );
    setLocale("zh");
    expect(statusTooltip("syncing", "笔记", progress)).toBe(
      "Courier：首次同步 — 已完成 1200 / 10000 个文件「笔记」",
    );
    setLocale("en");
  });

  it("drops the counter when the pass has finished", () => {
    // `done === total` is the engine's own "the pass finished" signal: leaving
    // "10 000 of 10 000" on the icon would be a first sync that never ends.
    expect(statusTooltip("syncing", null, { done: 10_000, total: 10_000 })).toBe(
      "Courier: Syncing",
    );
    // A report past the total (a total that shrank) is finished too.
    expect(statusTooltip("syncing", "Notes", { done: 10_001, total: 10_000 })).toBe(
      'Courier: Syncing in "Notes"',
    );
    // Nothing to count, and nothing to say about a pass that is not running.
    expect(statusTooltip("syncing", null, { done: 0, total: 0 })).toBe("Courier: Syncing");
    expect(statusTooltip("waiting", "Notes", progress)).toBe(
      'Courier: External sync service is syncing in "Notes"',
    );
    expect(statusTooltip("paused", null, progress)).toBe("Courier: Sync paused");
  });
});

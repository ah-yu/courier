import { t, type PluginMessageKey } from "../i18n";

/**
 * The four states the status bar shows.
 *
 * `syncing` is a **connection** state, not a per-file transfer: the host is running and
 * either its WebSocket is subscribed or it is still carrying out its first pass. A host
 * that is running while the socket is still connecting — or one that lost the socket and
 * is backing off — is `not-synced`, which is the state that tells the user something is
 * wrong. The *first* pass is the exception: it runs before the socket exists, so without
 * `binding` a fresh connect of a large vault showed the "something is wrong" icon for a
 * whole minute.
 */
export const SYNC_STATUSES = [
  "not-connected",
  "not-synced",
  "syncing",
  "waiting",
  "paused",
] as const;

export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** Everything the status derivation reads, kept explicit so it is a pure unit test. */
export interface SyncStatusInput {
  connectedVaultId: string | null;
  userKey: string | null;
  syncPaused: boolean;
  hostRunning: boolean;
  wsState: string;
  /** The CLI (or another writer) owns this vault's lease; this host is not syncing. */
  leaseWaiting?: boolean;
  /** The host is still carrying out its bind pass (it has no socket yet). */
  binding?: boolean;
}

/**
 * The one mapping from plugin state to a status-bar state.
 *
 * The order is the whole rule: without a binding (or without a key) there is nothing to
 * synchronise, so a stale pause flag cannot make the icon claim a paused vault. A bound
 * vault that is paused is paused even while the host is being stopped. A bind pass counts
 * as syncing — it is work, not a fault, and it is the state a first connect is in for as
 * long as the pass takes.
 */
export function syncStatusOf(input: SyncStatusInput): SyncStatus {
  const bound = Boolean(input.connectedVaultId && input.userKey);
  if (!bound) return "not-connected";
  if (input.syncPaused) return "paused";
  if (input.leaseWaiting) return "waiting";
  if (input.hostRunning && (input.wsState === "connected" || input.binding === true)) {
    return "syncing";
  }
  return "not-synced";
}

const STATUS_ICONS: Record<SyncStatus, string> = {
  "not-connected": "cloud-off",
  "not-synced": "circle-slash",
  syncing: "refresh-cw",
  waiting: "lock",
  paused: "pause",
};

const STATUS_KEYS: Record<SyncStatus, PluginMessageKey> = {
  "not-connected": "status.state.notConnected",
  "not-synced": "status.state.notSynced",
  syncing: "status.state.syncing",
  waiting: "status.state.waiting",
  paused: "status.state.paused",
};

/** The Lucide icon id for a status. */
export function statusIcon(status: SyncStatus): string {
  return STATUS_ICONS[status];
}

/** The localized label for a status. */
export function statusLabel(status: SyncStatus): string {
  return t(STATUS_KEYS[status]);
}

/** How far a pass has got, as the status bar shows it (the engine's `SyncProgress`). */
export interface StatusProgress {
  done: number;
  total: number;
}

/**
 * The tooltip — the element's `aria-label`, which Obsidian also shows on hover.
 *
 * The element is icon-only by design, so this is where the whole state is written in
 * words and where a first pass's counter goes. The counter is shown **only while
 * syncing** (a paused or not-connected host has no pass) and only for a pass still in
 * flight: `done === total` is the engine's own "the pass finished" signal
 * (`SyncProgress`), so a completed first sync drops the counter rather than leaving
 * "10 000 of 10 000" on the icon.
 */
export function statusTooltip(
  status: SyncStatus,
  vaultName: string | null,
  progress: StatusProgress | null,
): string {
  const label = statusLabel(status);
  const counted =
    status === "syncing" &&
    progress !== null &&
    progress.total > 0 &&
    progress.done < progress.total
      ? progress
      : null;
  if (counted === null) {
    return vaultName === null
      ? t("status.tooltip", { state: label })
      : t("status.tooltipVault", { state: label, vault: vaultName });
  }
  return vaultName === null
    ? t("status.tooltipFirstSync", { done: counted.done, total: counted.total })
    : t("status.tooltipFirstSyncVault", {
        done: counted.done,
        total: counted.total,
        vault: vaultName,
      });
}

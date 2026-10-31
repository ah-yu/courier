import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";

/**
 * One daemon process's runtime record, at `~/.courier-cli/runtime/<vault>.json`.
 *
 * A vault is synced by **its own process**; there is no multi-vault daemon. This file is
 * therefore one process's own state, and another process — a supervisor, or
 * `courier-cli status` — can tell whether that process is alive and what it is doing.
 * It is deliberately **advisory**: liveness is decided by asking the operating system
 * about `pid`, never by trusting the file. A crashed process therefore reads as stopped
 * even though its last record is still on disk.
 *
 * `phase` is the state the daemon itself reports:
 *
 * - `starting` — the supervisor is up, the first pass is not.
 * - `syncing` — the engine host is running.
 * - `waiting` — the daemon has deliberately parked because Obsidian's plugin owns this
 *   vault lease; it keeps retrying and starts when the lease is released.
 * - `stopped` — the daemon stopped for a reason it cannot retry (the key was revoked, the
 *   remote vault was deleted).
 */
export interface DaemonRuntime {
  version: 1;
  vaultId: string;
  vaultPath: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
  phase: "starting" | "syncing" | "waiting" | "stopped";
  /**
   * Why the daemon is in this phase; `other-writer` means the lease is held elsewhere,
   * and the three `key-*` reasons are the ways a credential stops working (revoked =
   * the account was deleted, expired = its validity ran out, disabled = the host
   * paused it without deleting anything).
   */
  reason:
    | "startup"
    | "other-writer"
    | "running"
    | "key-revoked"
    | "key-expired"
    | "key-disabled"
    | "vault-deleted"
    | "failed";
  serverUrl: string;
  deviceName: string;
  /** The last sync decision the engine reported, RFC 3339; absent means none yet. */
  lastActivityAt?: string;
  /** The latest failure, kept until a later pass clears it. */
  lastError?: string;
  /**
   * This device had no sync state for the vault when this process started: the pass it is
   * running is a **first sync**, not a startup scan of an already-bound vault.
   */
  firstSync?: boolean;
  /** How far the current pass has got; absent when no pass is running. */
  progress?: DaemonProgress;
}

/** What `status` reports about one vault's daemon; `running` is the OS's answer. */
export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  updatedAt: string | null;
  phase: DaemonRuntime["phase"] | null;
  reason: DaemonRuntime["reason"] | null;
  lastActivityAt: string | null;
  lastError: string | null;
  /** See {@link DaemonRuntime.firstSync}. */
  firstSync: boolean;
  /** See {@link DaemonRuntime.progress}. */
  progress: DaemonProgress | null;
}

/** The CLI config directory, shared by every vault on this machine. */
function configDir(): string {
  return process.env.COURIER_CLI_CONFIG_DIR ?? path.join(homedir(), ".courier-cli");
}

/** A vault id as a safe file-name segment. The id comes from the server. */
function vaultKey(vaultId: string): string {
  return new Bun.CryptoHasher("sha256").update(vaultId).digest("hex").slice(0, 24);
}

export function runtimeDir(): string {
  return path.join(configDir(), "runtime");
}

export function runtimePath(vaultId: string): string {
  return path.join(runtimeDir(), `${vaultKey(vaultId)}.json`);
}

/** Read one vault's record, or null when there is none or it is unreadable. */
export function readRuntime(vaultId: string): DaemonRuntime | null {
  try {
    const parsed = JSON.parse(
      readFileSync(runtimePath(vaultId), "utf-8"),
    ) as Partial<DaemonRuntime>;
    if (
      parsed.vaultId !== vaultId ||
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      (parsed.phase !== "starting" &&
        parsed.phase !== "syncing" &&
        parsed.phase !== "waiting" &&
        parsed.phase !== "stopped") ||
      typeof parsed.reason !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      vaultId,
      vaultPath: typeof parsed.vaultPath === "string" ? parsed.vaultPath : "",
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      updatedAt: parsed.updatedAt,
      phase: parsed.phase,
      reason: parsed.reason as DaemonRuntime["reason"],
      serverUrl: typeof parsed.serverUrl === "string" ? parsed.serverUrl : "",
      deviceName: typeof parsed.deviceName === "string" ? parsed.deviceName : "",
      lastActivityAt: typeof parsed.lastActivityAt === "string" ? parsed.lastActivityAt : undefined,
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : undefined,
      ...(parsed.firstSync === true ? { firstSync: true } : {}),
      ...(readProgress(parsed.progress) === undefined
        ? {}
        : { progress: readProgress(parsed.progress) }),
    };
  } catch {
    return null;
  }
}

/** A `progress` field as the record trusts it: two non-negative integers, or nothing. */
function readProgress(raw: unknown): DaemonProgress | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const candidate = raw as { done?: unknown; total?: unknown };
  const done = candidate.done;
  const total = candidate.total;
  if (!Number.isSafeInteger(done) || !Number.isSafeInteger(total)) return undefined;
  if ((done as number) < 0 || (total as number) <= 0) return undefined;
  return { done: done as number, total: total as number };
}

/** Whether a process with this id exists. `EPERM` counts as alive. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as Bun.SystemError).code === "EPERM";
  }
}

/** Forget one vault's record; a stopped daemon has no runtime state. */
export function clearRuntime(vaultId: string): void {
  try {
    unlinkSync(runtimePath(vaultId));
  } catch {
    // Already gone, or the directory is not writable. A stale file is harmless:
    // liveness is decided by the pid, never by this file.
  }
}

/** Answer what one vault's daemon is doing, and treat a dead pid as stopped. */
export function daemonStatus(vaultId: string): DaemonStatus {
  const runtime = readRuntime(vaultId);
  if (!runtime) {
    return {
      running: false,
      pid: null,
      startedAt: null,
      updatedAt: null,
      phase: null,
      reason: null,
      lastActivityAt: null,
      lastError: null,
      firstSync: false,
      progress: null,
    };
  }
  const running = processAlive(runtime.pid);
  if (!running) {
    // Best effort: the next daemon overwrites this anyway.
    clearRuntime(vaultId);
  }
  return {
    running,
    pid: runtime.pid,
    startedAt: runtime.startedAt,
    updatedAt: runtime.updatedAt,
    phase: running ? runtime.phase : null,
    reason: running ? runtime.reason : null,
    lastActivityAt: running ? (runtime.lastActivityAt ?? null) : null,
    lastError: running ? (runtime.lastError ?? null) : null,
    firstSync: running && runtime.firstSync === true,
    progress: running ? (runtime.progress ?? null) : null,
  };
}

/**
 * How far the current pass has got, as the daemon's own record carries it.
 *
 * `total` grows during a bind (the files to create are discovered as the vault is
 * walked), so this is a counter, not a fixed job. Written at most every
 * {@link PROGRESS_WRITE_MS}: the engine reports every 25 files, and a status reader polls
 * the directory, so a write per report would be pure disk traffic.
 */
export interface DaemonProgress {
  done: number;
  total: number;
}

/** How often the daemon rewrites its record for a progress report. */
const PROGRESS_WRITE_MS = 2_000;

/**
 * Write one vault's daemon record. This runs in the daemon process, so `pid` is this
 * process and the caller never has to pass one.
 *
 * `touch` is separate from `set`: activity can arrive many times a second, and rewriting
 * the file for every file event would turn the engine's progress into disk traffic.
 */
export class RuntimeWriter {
  private state: DaemonRuntime;
  private lastActivityWrite = 0;
  private lastProgressWrite = 0;

  constructor(
    private readonly vault: { vaultId: string; vaultPath: string },
    private readonly serverUrl: string,
    private readonly deviceName: string,
    private readonly now: () => Date = () => new Date(),
    /** This device has no sync state for the vault yet: its first pass is a real first sync. */
    private readonly firstSync = false,
  ) {
    const stamp = this.now().toISOString();
    this.state = {
      version: 1,
      vaultId: vault.vaultId,
      vaultPath: vault.vaultPath,
      pid: process.pid,
      startedAt: stamp,
      updatedAt: stamp,
      phase: "starting",
      reason: "startup",
      serverUrl,
      deviceName,
      ...(firstSync ? { firstSync: true } : {}),
    };
  }

  start(): void {
    this.write();
  }

  set(change: Partial<Pick<DaemonRuntime, "phase" | "reason" | "lastError">>): void {
    Object.assign(this.state, change);
    if (change.lastError === null || change.lastError === "") delete this.state.lastError;
    // A phase change means the pass that reported a counter is over.
    if (change.phase !== undefined) delete this.state.progress;
    this.write();
  }

  /** Record that the engine made a decision, at most every five seconds. */
  touchActivity(): void {
    const now = this.now();
    if (now.getTime() - this.lastActivityWrite < 5_000) return;
    this.lastActivityWrite = now.getTime();
    this.state.lastActivityAt = now.toISOString();
    this.write();
  }

  /**
   * Record how far the current pass has got, at most every {@link PROGRESS_WRITE_MS}.
   *
   * The first report after a phase change is written immediately: the file watcher on the
   * other side then shows a counter the moment the pass starts rather than after a
   * throttle window of silence.
   */
  setProgress(done: number, total: number): void {
    if (total <= 0) return;
    // A finished pass is not progress. The engine's last report has `done === total`, and
    // the report before it may have been throttled away, so this is the one place that
    // guarantees the counter is gone when the pass ends (a phase change also clears it).
    if (done >= total) {
      this.clearProgress();
      return;
    }
    const now = this.now();
    const first = this.state.progress === undefined;
    if (!first && now.getTime() - this.lastProgressWrite < PROGRESS_WRITE_MS) return;
    this.lastProgressWrite = now.getTime();
    this.state.progress = { done, total };
    this.write();
  }

  /** Forget the counter — a finished pass is not progress. */
  clearProgress(): void {
    if (this.state.progress === undefined) return;
    delete this.state.progress;
    this.write();
  }

  clear(): void {
    clearRuntime(this.vault.vaultId);
  }

  private write(): void {
    this.state.updatedAt = this.now().toISOString();
    try {
      mkdirSync(runtimeDir(), { recursive: true });
      writeFileSync(runtimePath(this.state.vaultId), JSON.stringify(this.state, null, 2), "utf-8");
    } catch {
      // The daemon must sync even when it cannot write its own status file. A supervisor
      // can still see the process; it just cannot see what it is doing.
    }
  }
}

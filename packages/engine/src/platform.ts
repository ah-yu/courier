/**
 * What the engine is allowed to assume about the runtime it runs on.
 *
 * Courier runs one engine in two worlds: Obsidian's renderer (the plugin, desktop and
 * mobile) and Bun (the CLI and the e2e suites). Both provide the Web platform's timers,
 * so a host does not *implement* time — but the two runtimes differ in ways that reach
 * behaviour, and each difference is a question a host has to answer:
 *
 * - **`unref()`.** Bun's timers can be marked "do not keep the process alive"; a renderer
 *   returns a number with no such thing, and a plugin does not need one. A host whose
 *   runtime can exit on its own (the CLI) wants its periodic timers unref'd; a plugin
 *   never does.
 * - **`process`.** The plugin has one on desktop (Electron) and none on mobile; the CLI
 *   always does. It is what the lease uses to recognise a holder that no longer exists.
 *
 * A call site holds a {@link TimerHandle}, never a timer id: the two runtimes return
 * different values (`Timeout` vs `number`), and `cancel` plus an optional `unref` are the
 * only two things the engine ever does with one.
 *
 * This module is the **contract only** — it names no global, because a published build of
 * the plugin must lint clean as Obsidian plugin source. Each host implements it where it
 * can name its own runtime truthfully: `packages/plugin/src/platform.ts` (`window.*`),
 * `packages/cli/src/platform.ts` (Bun's timers plus `unref`), and `@courier/testing` for
 * the suites.
 */

/** A scheduled callback, as a value the engine can cancel or unref. */
export interface TimerHandle {
  /** Cancel the pending callback. Safe to call after it has already run. */
  cancel(): void;
  /**
   * Let the runtime exit while this timer is still pending, where the runtime supports
   * it. Absent where it means nothing (a renderer, which is kept alive by its window).
   */
  unref?(): void;
}

/**
 * The Node surface, when the runtime has one.
 *
 * Every member is optional because the answer is "no" on some runtime — the plugin on
 * mobile has no process table at all, and the lease has to keep working there.
 */
export interface NodeSurface {
  /** The process id, or absent where the runtime has no process table. */
  pid?: number;
  /** The environment this process inherited, when it is exposed. */
  env?: Record<string, string | undefined>;
  /** `process.kill`; the lease uses `kill(pid, 0)` as a liveness probe. */
  kill?(pid: number, signal: number): boolean;
}

/** The runtime capabilities the engine needs from its host. */
export interface Platform {
  /** Run `fn` once, after `ms`. */
  after(ms: number, fn: () => void): TimerHandle;
  /** Run `fn` every `ms`. */
  every(ms: number, fn: () => void): TimerHandle;
  /**
   * The Node surface this runtime has, or `undefined` where it has none (the plugin on
   * mobile).
   *
   * Required, so a host cannot *omit* it by accident: a missing surface and an absent one
   * behave the same — the lease falls back to expiry alone — and the difference is a
   * holder that outlives its process until the TTL runs out. `undefined` is a statement
   * about the runtime; silence is a mistake.
   */
  readonly process: NodeSurface | undefined;
}

/**
 * Test helpers shared by the package suites.
 *
 * A package of its own on purpose: they used to live under `@courier/shared`,
 * which meant the production package exported them (`@courier/shared/testing`)
 * and a reader could not tell test code from shipped code. Nothing outside a
 * `*.test.ts` / harness file imports this package, and it is a
 * `devDependencies` entry everywhere it is used.
 *
 * They exist because the test runner has no equivalent for three things the suites
 * need in several packages.
 */
import { rmSync } from "fs";
import { vi } from "vitest";

/**
 * These helpers run under both runtimes this repository tests on: Bun (the suite's
 * runtime, and every host except Obsidian) and Node (Stryker drives Vitest under Node
 * when it surveys mutants). Nothing here may assume the `Bun` global.
 */
function sleep(ms: number): Promise<void> {
  const bun = (globalThis as { Bun?: { sleep(ms: number): Promise<void> } }).Bun;
  return bun ? bun.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
}

/** Collect garbage where the runtime can; a no-op elsewhere. */
function collectGarbage(): void {
  (globalThis as { Bun?: { gc(force?: boolean): void } }).Bun?.gc(true);
}

/** Globals a test replaced, with the value each had before the first stub. */
const savedGlobals = new Map<string, unknown>();

/**
 * Replace a global for the rest of the test. `restoreGlobals()` in `afterEach`
 * is what keeps one file's fake `WebSocket` out of the next.
 */
export function stubGlobal(name: string, value: unknown): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  if (!savedGlobals.has(name)) savedGlobals.set(name, globals[name]);
  globals[name] = value;
}

/** Put every stubbed global back the way it was. */
export function restoreGlobals(): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const [name, value] of savedGlobals) globals[name] = value;
  savedGlobals.clear();
}

/**
 * Remove a temp directory, retrying while the OS still holds a file open.
 *
 * Windows keeps a SQLite file mapped for a moment after `close()`; a single
 * `rmSync` in `afterAll` fails with EBUSY and turns a green suite red. The budget
 * is per directory, not per attempt, so an instrumented run — where the same
 * release takes noticeably longer — cannot run out of retries and fail on a
 * timing difference rather than on the code under test. A healthy run still
 * removes the directory on the first attempt.
 */
export async function removeDirWithRetry(dir: string, budgetMs = 15_000): Promise<void> {
  const deadline = performance.now() + budgetMs;
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (performance.now() >= deadline) throw error;
      // A closed SQLite handle with lingering statements qualifies for collection
      // before Windows releases the mapping.
      collectGarbage();
      await sleep(Math.min(50 * (attempt + 1), 250));
    }
  }
}

/**
 * Advance faked timers and let the microtasks they scheduled run.
 *
 * The runner exposes the synchronous `vi.advanceTimersByTime` only, which fires the
 * timers that exist when it is called. Work that *schedules* the next timer runs in a
 * microtask continuation (`await acquire()` → `catch` → `setTimeout(retry)`), so the
 * advance is split into slices with a microtask drain between them: a single jump would
 * fire one retry and leave the next one scheduled after the window had already closed.
 * A real sleep cannot be used here: the fake timers would never resolve it.
 */
export async function advanceTimersByTimeAsync(ms: number): Promise<void> {
  const SLICE_MS = 25;
  let remaining = ms;
  do {
    const step = Math.min(SLICE_MS, remaining);
    vi.advanceTimersByTime(step);
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    remaining -= step;
  } while (remaining > 0);
}

export interface WaitForOptions {
  /** Give up after this many milliseconds of wall clock. Default 5 000. */
  timeout?: number;
  /** Step between attempts. Default 25 ms. */
  interval?: number;
}

/**
 * Poll `assertion` until it stops throwing, then return; rethrow its last error
 * on timeout.
 *
 * Works under both kinds of clock. With real timers it advances fake timers
 * (which throws, and that is how the mode is detected) and sleeps for the
 * interval. With faked timers it advances them a step and drains the microtask
 * queue instead. Wall-clock
 * limits come from `performance.now()`, which the fake `Date` does not move.
 */
export async function waitFor(
  assertion: () => void | Promise<void>,
  options: WaitForOptions = {},
): Promise<void> {
  const timeout = options.timeout ?? 5_000;
  const interval = options.interval ?? 25;
  const deadline = performance.now() + timeout;
  let lastError: unknown;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    if (performance.now() >= deadline) throw lastError;
    let faked = true;
    try {
      vi.advanceTimersByTime(interval);
    } catch {
      faked = false;
    }
    if (faked) {
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    } else {
      await sleep(interval);
    }
  }
}

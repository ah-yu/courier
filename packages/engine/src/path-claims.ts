/**
 * The paths one pass's per-file work currently owns.
 *
 * A pass runs its per-file work concurrently (see `WorkPool`), and every task is a
 * different fileId — but two *different chains* can still name one path for a moment.
 * A peer's rename is recorded on the server while this device's file is still at the
 * old path, and another device can have created a new chain at that same path. Both
 * tasks would then decide from the same bytes: one would move or delete the file, and
 * the other would read that file as a divergence and park a conflict copy of content
 * that never conflicted.
 *
 * A claim is **not** a lock on the engine's operations and nothing in the engine ever
 * waits on a path (a host whose adapter awaits the event its own write fires would
 * deadlock). It only orders the tasks **of one pass**: a task waits until every path it
 * may write is free, and an owner is scheduled before a remote-only chain at the same
 * path (see `orderByPriority`), so the chain whose file is on disk settles it first.
 *
 * Waiting is safe from deadlock because a claim is only ever held by a task that is
 * already running (never by one still queued behind the waiter).
 */
export class PathClaims {
  private readonly held = new Set<string>();
  private readonly waiting: Array<{ paths: readonly string[]; ready: () => void }> = [];

  /**
   * Wait until every path in `paths` is free, then claim all of them.
   *
   * The check and the claim happen in one synchronous step, so two tasks cannot both
   * pass the check for an overlapping set.
   */
  async acquire(paths: readonly string[]): Promise<void> {
    while (paths.some((path) => this.held.has(path))) {
      await new Promise<void>((ready) => this.waiting.push({ paths, ready }));
    }
    for (const path of paths) this.held.add(path);
  }

  /**
   * Release every path in `paths` and wake the waiters to try again.
   *
   * Every waiter is woken rather than only the first: a waiter whose set overlaps the
   * released path may still be blocked by another holder, and re-queueing is cheaper
   * than tracking which waiters each path releases. A pass has at most as many waiters
   * as it has concurrent tasks.
   */
  release(paths: readonly string[]): void {
    for (const path of paths) this.held.delete(path);
    for (const waiter of this.waiting.splice(0)) waiter.ready();
  }

  /** How many paths are claimed right now (diagnostics and tests). */
  get size(): number {
    return this.held.size;
  }
}

/**
 * A tiny scheduler for the work a **host** starts from an event.
 *
 * It is not part of `SyncEngine` and deliberately so: the engine's own rule is that
 * nothing ever waits on a path (a host whose adapter awaits the event its own write
 * fires would deadlock otherwise). This sits one level above it, where the question
 * is different — *how many* of the engine's operations may be in flight at once.
 *
 * Why that matters, measured: pushing or pulling a file holds at least four copies of
 * it at once (plaintext, ciphertext, and the two strings a JSON body used to need),
 * so a folder dropped into Obsidian — one event per file, all handled in the same
 * tick — used to start one full-file encryption per file simultaneously. Ten 40 MiB
 * attachments is well over a gigabyte of transient allocations, which is how a phone
 * runs out of memory. With a queue, the same drop runs the large files one at a time
 * and never more than `maxConcurrent` small ones.
 */

export type OpWeight = "small" | "exclusive";

export interface OpQueueLimits {
  /** How many small operations may run at the same time. */
  maxConcurrent: number;
  /** At or above this many bytes, an operation runs alone. */
  exclusiveBytes: number;
}

/**
 * Defaults sized for the smallest host (a phone): four small operations at once, and
 * anything from 8 MiB up on its own. 8 MiB is above every note, image and settings
 * file and below the videos, PDFs and audio files that actually threaten memory.
 */
export const DEFAULT_OP_QUEUE_LIMITS: OpQueueLimits = {
  maxConcurrent: 4,
  exclusiveBytes: 8 * 1024 * 1024,
};

/**
 * The weight to give an operation of a known (or unknown) size.
 *
 * An unknown size is treated as the worst case, not the best: the caller that cannot
 * measure the payload — a websocket notification, whose size only becomes known after
 * the chain is fetched — is exactly the one that can be handed a 50 MiB file, and
 * four of those at once is what this exists to prevent.
 */
export function weightForSize(limits: OpQueueLimits, sizeBytes: number | null): OpWeight {
  if (sizeBytes === null) return "exclusive";
  return sizeBytes >= limits.exclusiveBytes ? "exclusive" : "small";
}

interface PendingOp {
  label: string;
  weight: OpWeight;
  run: () => Promise<unknown> | undefined;
}

/**
 * FIFO, with two rules:
 *
 * - An `exclusive` operation starts only when nothing else is running.
 * - A `small` operation starts only while no exclusive one is running and fewer than
 *   `maxConcurrent` are.
 *
 * Because the queue is FIFO, an exclusive operation that is waiting also holds back
 * the small ones behind it — otherwise a steady stream of small edits could starve a
 * large file forever. Nothing here blocks the engine: a queued operation simply has
 * not started yet, and every decision it takes is taken when it runs.
 */
export class OpQueue {
  private waiting: PendingOp[] = [];
  private inFlight = 0;
  private exclusiveInFlight = false;

  constructor(
    private readonly limits: OpQueueLimits = DEFAULT_OP_QUEUE_LIMITS,
    /** Where a failed operation is reported — the host's own logger. */
    private readonly onError: (label: string, err: unknown) => void = () => {},
  ) {}

  /** How many operations are running right now (diagnostics and tests). */
  get running(): number {
    return this.inFlight;
  }

  /** How many are waiting to start (diagnostics and tests). */
  get queued(): number {
    return this.waiting.length;
  }

  /**
   * Queue one operation. It runs as soon as the limits allow, and its failure is
   * reported through `onError` rather than becoming an unhandled rejection — these
   * are started from synchronous event handlers that nobody awaits.
   */
  enqueue(label: string, weight: OpWeight, run: () => Promise<unknown> | undefined): void {
    this.waiting.push({ label, weight, run });
    this.pump();
  }

  private pump(): void {
    for (;;) {
      const next = this.waiting[0];
      if (!next) return;
      if (next.weight === "exclusive") {
        if (this.inFlight > 0) return;
      } else if (this.exclusiveInFlight || this.inFlight >= this.limits.maxConcurrent) {
        return;
      }

      this.waiting.shift();
      this.inFlight++;
      if (next.weight === "exclusive") this.exclusiveInFlight = true;

      void Promise.resolve()
        .then(next.run)
        .catch((err: unknown) => this.onError(next.label, err))
        .finally(() => {
          this.inFlight--;
          if (next.weight === "exclusive") this.exclusiveInFlight = false;
          this.pump();
        });
    }
  }
}

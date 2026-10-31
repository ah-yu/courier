import { describe, expect, it, vi } from "vitest";
import { DEFAULT_OP_QUEUE_LIMITS, OpQueue, weightForSize } from "./op-queue";

/** A promise whose resolution the test controls. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let every already-scheduled microtask run, so the queue can start what it may. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("weightForSize", () => {
  it("ships defaults sized for the smallest host: four at once, 8 MiB alone", () => {
    // Pinned as a value, not only through `limits.exclusiveBytes`: a mutation run changed
    // `8 * 1024 * 1024` to `8 / 1024` and to `8 * 1024` and the suite stayed green, because
    // every case above reads the bound from the object it is testing. This is the number a
    // phone's memory safety rests on, and both hosts default to it.
    expect(DEFAULT_OP_QUEUE_LIMITS).toEqual({ maxConcurrent: 4, exclusiveBytes: 8 * 1024 * 1024 });
  });

  it("keeps a small file in the concurrent lane", () => {
    expect(weightForSize(DEFAULT_OP_QUEUE_LIMITS, 0)).toBe("small");
    expect(weightForSize(DEFAULT_OP_QUEUE_LIMITS, DEFAULT_OP_QUEUE_LIMITS.exclusiveBytes - 1)).toBe(
      "small",
    );
  });

  it("gives a file at or over the bound the exclusive lane", () => {
    expect(weightForSize(DEFAULT_OP_QUEUE_LIMITS, DEFAULT_OP_QUEUE_LIMITS.exclusiveBytes)).toBe(
      "exclusive",
    );
    expect(weightForSize(DEFAULT_OP_QUEUE_LIMITS, 100 * 1024 * 1024)).toBe("exclusive");
  });

  it("treats an unknown size as the worst case, not the best", () => {
    // A websocket notification's payload is unknown until its chain is fetched, and
    // it is exactly the path a peer's 50 MiB attachment arrives on.
    expect(weightForSize(DEFAULT_OP_QUEUE_LIMITS, null)).toBe("exclusive");
  });
});

describe("OpQueue", () => {
  it("runs small operations up to the concurrency limit", async () => {
    const queue = new OpQueue({ maxConcurrent: 2, exclusiveBytes: 1024 });
    const gates = [deferred(), deferred(), deferred()];
    for (const [index, gate] of gates.entries()) {
      queue.enqueue(`op-${index}`, "small", () => gate.promise);
    }
    await settle();

    expect(queue.running).toBe(2);
    expect(queue.queued).toBe(1);

    gates[0]!.resolve();
    await settle();
    expect(queue.running).toBe(2);
    expect(queue.queued).toBe(0);

    gates[1]!.resolve();
    gates[2]!.resolve();
    await settle();
    expect(queue.running).toBe(0);
  });

  it("runs an exclusive operation alone, even when a slot is free", async () => {
    const queue = new OpQueue({ maxConcurrent: 4, exclusiveBytes: 1024 });
    const small = deferred();
    const large = deferred();
    queue.enqueue("small", "small", () => small.promise);
    queue.enqueue("large", "exclusive", () => large.promise);
    await settle();

    // One small operation is running, so the exclusive one has not started — and
    // nothing else has either, because the queue is FIFO behind it.
    expect(queue.running).toBe(1);
    expect(queue.queued).toBe(1);

    small.resolve();
    await settle();
    expect(queue.running).toBe(1);
    expect(queue.queued).toBe(0);

    large.resolve();
    await settle();
    expect(queue.running).toBe(0);
  });

  it("does not let small operations starve an exclusive one behind them", async () => {
    const queue = new OpQueue({ maxConcurrent: 4, exclusiveBytes: 1024 });
    const gates = Array.from({ length: 6 }, () => deferred());
    const started: string[] = [];
    gates.forEach((gate, index) => {
      queue.enqueue(`op-${index}`, index === 3 ? "exclusive" : "small", () => {
        started.push(`op-${index}`);
        return gate.promise;
      });
    });
    await settle();

    // Three small operations run (FIFO); the fourth is exclusive, so it waits for the
    // drain — and the two behind it do not overtake it.
    expect(started).toEqual(["op-0", "op-1", "op-2"]);
    gates[0]!.resolve();
    gates[1]!.resolve();
    gates[2]!.resolve();
    await settle();
    expect(started).toEqual(["op-0", "op-1", "op-2", "op-3"]);

    for (const gate of gates.slice(3)) gate.resolve();
    await settle();
    expect(started).toHaveLength(6);
  });

  it("reports a failure instead of leaking it as an unhandled rejection", async () => {
    const onError = vi.fn();
    const queue = new OpQueue({ maxConcurrent: 1, exclusiveBytes: 1024 }, onError);
    queue.enqueue("boom", "small", async () => {
      throw new Error("push failed");
    });
    await settle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe("boom");
    const reported = onError.mock.calls[0]?.[1] as Error | undefined;
    expect(reported?.message).toBe("push failed");
    // A failure frees the slot: the next operation still runs.
    expect(queue.running).toBe(0);
  });

  it("tolerates a run function that returns nothing", async () => {
    // Hosts write `() => this.engine?.handleLocalChange(path)`, whose return is
    // `Promise<void> | undefined` — the queue has to accept both.
    const queue = new OpQueue({ maxConcurrent: 1, exclusiveBytes: 1024 });
    queue.enqueue("noop", "small", () => undefined);
    await settle();
    expect(queue.running).toBe(0);
  });
});

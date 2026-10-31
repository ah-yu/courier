import { describe, expect, it } from "vitest";
import { WorkPool } from "./work-pool";
import type { OpQueueLimits } from "./op-queue";

/** Let the pool's promise chain turn over before asserting what started. */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const LIMITS: OpQueueLimits = { maxConcurrent: 2, exclusiveBytes: 8 };

describe("WorkPool", () => {
  it("runs at most maxConcurrent small tasks and starts the next one as a slot frees", async () => {
    const pool = new WorkPool(LIMITS);
    const gates = [gate(), gate(), gate(), gate(), gate()];
    const started: number[] = [];
    const runs = gates.map((entry, index) =>
      pool.run("small", async () => {
        started.push(index);
        await entry.promise;
      }),
    );

    await flush();
    expect(started).toEqual([0, 1]);
    expect(pool.running).toBe(2);
    expect(pool.queued).toBe(3);

    gates[0]!.resolve();
    await runs[0];
    await flush();
    expect(started).toEqual([0, 1, 2]);
    expect(pool.running).toBe(2);
    expect(pool.queued).toBe(2);

    for (const entry of gates.slice(1)) entry.resolve();
    await Promise.all(runs);
    await flush();
    expect(started).toHaveLength(5);
    expect(pool.running).toBe(0);
    expect(pool.queued).toBe(0);
  });

  it("runs an exclusive task alone, and holds the small tasks behind it", async () => {
    const pool = new WorkPool(LIMITS);
    const first = gate();
    const second = gate();
    const large = gate();
    const last = gate();
    const started: string[] = [];

    const runs = [
      pool.run("small", async () => {
        started.push("small-1");
        await first.promise;
      }),
      pool.run("small", async () => {
        started.push("small-2");
        await second.promise;
      }),
      pool.run("exclusive", async () => {
        started.push("large");
        expect(pool.running).toBe(1);
        await large.promise;
      }),
      pool.run("small", async () => {
        started.push("small-3");
        await last.promise;
      }),
    ];

    await flush();
    expect(started).toEqual(["small-1", "small-2"]);

    // The large task waits until both small ones are done — including the second one
    // that was already running when it was queued.
    first.resolve();
    await flush();
    expect(started).toEqual(["small-1", "small-2"]);

    second.resolve();
    await flush();
    expect(started).toEqual(["small-1", "small-2", "large"]);
    expect(pool.running).toBe(1);

    large.resolve();
    await flush();
    expect(started).toEqual(["small-1", "small-2", "large", "small-3"]);

    last.resolve();
    await Promise.all(runs);
  });

  it("frees a slot when a task rejects, and reports that failure to its caller", async () => {
    const pool = new WorkPool({ maxConcurrent: 1, exclusiveBytes: 8 });
    const second = gate();
    const started: string[] = [];

    const first = pool.run("small", async () => {
      started.push("first");
      throw new Error("push failed");
    });
    const secondRun = pool.run("small", async () => {
      started.push("second");
      await second.promise;
    });

    await expect(first).rejects.toThrow("push failed");
    await flush();
    // The rejected slot is free: the next task started rather than hanging forever.
    expect(started).toEqual(["first", "second"]);
    expect(pool.running).toBe(1);

    second.resolve();
    await secondRun;
    await flush();
    expect(pool.running).toBe(0);
  });

  it("holds a small task behind an exclusive one that is already running", async () => {
    const pool = new WorkPool({ maxConcurrent: 2, exclusiveBytes: 8 });
    const large = gate();
    const small = gate();
    const started: string[] = [];

    const largeRun = pool.run("exclusive", async () => {
      started.push("large");
      await large.promise;
    });
    const smallRun = pool.run("small", async () => {
      started.push("small");
      await small.promise;
    });

    await flush();
    expect(started).toEqual(["large"]);

    large.resolve();
    await flush();
    expect(started).toEqual(["large", "small"]);

    small.resolve();
    await Promise.all([largeRun, smallRun]);
  });

  it("keeps FIFO order among equal weights", async () => {
    const pool = new WorkPool({ maxConcurrent: 1, exclusiveBytes: 8 });
    const started: number[] = [];
    const runs = [0, 1, 2].map((index) =>
      pool.run("small", async () => {
        started.push(index);
      }),
    );

    await Promise.all(runs);
    expect(started).toEqual([0, 1, 2]);
  });
});

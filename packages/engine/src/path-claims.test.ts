import { describe, expect, it } from "vitest";
import { PathClaims } from "./path-claims";

/** Let a woken waiter run its `acquire` loop before asserting. */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("PathClaims", () => {
  it("lets disjoint path sets run together", async () => {
    const claims = new PathClaims();

    await claims.acquire(["a.md"]);
    await claims.acquire(["b.md"]);

    expect(claims.size).toBe(2);
  });

  it("waits until every path in its set is free, and wakes on release", async () => {
    const claims = new PathClaims();
    await claims.acquire(["a.md", "b.md"]);

    let acquired = false;
    const waiting = claims.acquire(["b.md", "c.md"]).then(() => {
      acquired = true;
    });
    await flush();
    // `b.md` is still claimed, so the whole set waits — including the free `c.md`.
    expect(acquired).toBe(false);
    expect(claims.size).toBe(2);

    claims.release(["a.md", "b.md"]);
    await waiting;

    expect(acquired).toBe(true);
    expect(claims.size).toBe(2);
  });

  it("starts exactly one waiter at a time for the same path", async () => {
    const claims = new PathClaims();
    await claims.acquire(["p.md"]);

    let started = 0;
    const first = claims.acquire(["p.md"]).then(() => {
      started++;
    });
    const second = claims.acquire(["p.md"]).then(() => {
      started++;
    });
    await flush();
    expect(started).toBe(0);

    claims.release(["p.md"]);
    await flush();
    expect(started).toBe(1);

    claims.release(["p.md"]);
    await flush();
    expect(started).toBe(2);

    await Promise.all([first, second]);
  });

  it("claims nothing for an empty set, and releases only what was claimed", async () => {
    const claims = new PathClaims();

    await claims.acquire([]);
    expect(claims.size).toBe(0);

    await claims.acquire(["a.md"]);
    claims.release(["a.md", "never-claimed.md"]);

    expect(claims.size).toBe(0);
  });
});

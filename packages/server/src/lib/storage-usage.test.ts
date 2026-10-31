import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  invalidateStorageUsage,
  invalidateUserStorageUsage,
  recordUserStorageUsage,
  storageUsage,
  userStorageUsage,
  STORAGE_USAGE_TTL_MS,
  type StorageMeasurement,
} from "./storage-usage";

/**
 * The storage caches exist because the push route enforces a
 * `storage_bytes_limit` on every batch, and the measurement behind it walks every
 * one of that user's blob directories. These cases pin what the route depends on:
 * a burst costs one walk, and what a push wrote is counted without another.
 *
 * The cache is pure: the walk is injected, so importing this module never opens
 * SQLite or touches the blob store.
 */
beforeEach(() => {
  invalidateStorageUsage();
  invalidateUserStorageUsage();
});

describe("storageUsage", () => {
  it("measures once and serves the rest of the window from the cache", async () => {
    const measure = vi.fn(async () => ({ bytes: 100, blobs: 2, vaults: 1 }));

    const first = await storageUsage({ measure });
    const second = await storageUsage({ measure });

    expect(first).toMatchObject({ bytes: 100, blobs: 2, vaults: 1 });
    expect(second).toBe(first);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("measures again when forced", async () => {
    const measure = vi.fn(async () => ({ bytes: 100, blobs: 2, vaults: 1 }));

    await storageUsage({ measure });
    await storageUsage({ measure, force: true });

    expect(measure).toHaveBeenCalledTimes(2);
  });

  it("shares one measurement between callers that arrive together", async () => {
    let release!: (measurement: StorageMeasurement) => void;
    const measure = vi.fn(
      () =>
        new Promise<StorageMeasurement>((resolve) => {
          release = resolve;
        }),
    );

    const together = Promise.all([storageUsage({ measure }), storageUsage({ measure })]);
    release({ bytes: 300, blobs: 3, vaults: 1 });
    const [first, second] = await together;

    expect(first).toMatchObject({ bytes: 300, blobs: 3, vaults: 1 });
    expect(second).toBe(first);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed measurement", async () => {
    const measure = vi
      .fn<() => Promise<StorageMeasurement>>()
      .mockRejectedValueOnce(new Error("the disk went away"))
      .mockResolvedValue({ bytes: 50, blobs: 1, vaults: 1 });

    await expect(storageUsage({ measure })).rejects.toThrow("the disk went away");
    await expect(storageUsage({ measure })).resolves.toMatchObject({ bytes: 50 });
  });
});

describe("userStorageUsage", () => {
  it("measures once and serves the rest of the window from the cache", async () => {
    const measure = vi.fn(async () => 100);
    const first = await userStorageUsage("u-1", { measure });
    const second = await userStorageUsage("u-1", { measure });

    expect([first, second]).toEqual([100, 100]);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("measures again past the TTL, and when asked to", async () => {
    const measure = vi.fn(async () => 100);
    await userStorageUsage("u-1", { measure });

    // A forced read re-measures whatever the clock says — which is what a test and
    // a "the numbers look wrong" refresh both need.
    await userStorageUsage("u-1", { measure, force: true });
    expect(measure).toHaveBeenCalledTimes(2);

    // The TTL decides for everyone else.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + STORAGE_USAGE_TTL_MS + 1);
      invalidateUserStorageUsage();
      await userStorageUsage("u-1", { measure });
      await userStorageUsage("u-1", { measure });
      expect(measure).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts what a push wrote without measuring again", async () => {
    const measure = vi.fn(async () => 100);
    await userStorageUsage("u-1", { measure });

    recordUserStorageUsage("u-1", 40);
    await expect(userStorageUsage("u-1", { measure })).resolves.toBe(140);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("leaves a user nobody measured to the next walk", async () => {
    const measure = vi.fn(async () => 100);

    // Recording before measuring must not invent a number out of nothing.
    recordUserStorageUsage("u-2", 999);
    await expect(userStorageUsage("u-2", { measure })).resolves.toBe(100);
  });

  it("shares one measurement between callers that arrive together", async () => {
    let release!: (bytes: number) => void;
    const measure = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );

    const together = Promise.all([
      userStorageUsage("u-3", { measure }),
      userStorageUsage("u-3", { measure }),
    ]);
    release(300);
    await expect(together).resolves.toEqual([300, 300]);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed measurement", async () => {
    const measure = vi
      .fn<(userId: string) => Promise<number>>()
      .mockRejectedValueOnce(new Error("the disk went away"))
      .mockResolvedValue(50);

    await expect(userStorageUsage("u-4", { measure })).rejects.toThrow("the disk went away");
    await expect(userStorageUsage("u-4", { measure })).resolves.toBe(50);
  });
});

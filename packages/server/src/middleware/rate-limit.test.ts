import { afterEach, describe, expect, it } from "vitest";
import { syncRateLimitOptions, syncTransferRateLimitOptions } from "./rate-limit";

/** `process.env` overrides a test set, with the value each had before the first stub. */
const savedEnv = new Map<string, string | undefined>();

function stubEnv(name: string, value: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  process.env[name] = value;
}

/** The two sync budgets: ordinary requests, and the blocks of one file transfer. */
describe("sync rate-limit options", () => {
  afterEach(() => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    savedEnv.clear();
  });

  it("gives transfer routes their own, larger budget and store", () => {
    const sync = syncRateLimitOptions();
    const transfer = syncTransferRateLimitOptions();

    // A 50 MiB version is 13 ranges, and a first download is one request per remote
    // file: the transfer allowance must not refuse either partway through.
    expect(transfer.maxAttempts).toBeGreaterThan(sync.maxAttempts);
    expect(transfer.keyPrefix).not.toBe(sync.keyPrefix);
    expect(transfer.windowMs).toBe(60_000);
  });

  it("sizes the sync budget for a first bind, not for a steady-state edit", () => {
    // One push carries up to 100 files, so the deployed allowance has to cover a vault of
    // tens of thousands of files inside a window or two; 120/min turned every bind above
    // ~12 000 files into a failed pass (see `docs/first-bind-performance.md`). The transfer
    // budget is one request per remote file, so it has to clear a 50 000-file download.
    expect(syncRateLimitOptions().maxAttempts).toBeGreaterThanOrEqual(500);
    expect(syncTransferRateLimitOptions().maxAttempts).toBeGreaterThanOrEqual(50_000);
  });

  it("reads both budgets from their environment overrides", () => {
    stubEnv("SYNC_RATE_LIMIT_MAX_ATTEMPTS", "7");
    stubEnv("SYNC_TRANSFER_RATE_LIMIT_MAX_ATTEMPTS", "5000");
    stubEnv("SYNC_TRANSFER_RATE_LIMIT_WINDOW_MS", "1000");

    expect(syncRateLimitOptions().maxAttempts).toBe(7);
    expect(syncTransferRateLimitOptions()).toMatchObject({
      maxAttempts: 5000,
      windowMs: 1000,
    });
  });

  it("ignores an unusable override instead of disabling the limit", () => {
    stubEnv("SYNC_TRANSFER_RATE_LIMIT_MAX_ATTEMPTS", "0");
    expect(syncTransferRateLimitOptions().maxAttempts).toBe(60_000);
  });
});

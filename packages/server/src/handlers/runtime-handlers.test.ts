import { describe, expect, it } from "vitest";
import { buildRuntimeResponse, cpuPercentBetween } from "./runtime-handlers";

/**
 * The runtime route is the cheap half of the admin API: what the process consumes
 * right now. These assertions pin the arithmetic a UI depends on — a percentage
 * that must not look like a zero when there is nothing to compare, a load average
 * that is always three numbers, and an uptime in whole seconds.
 */
describe("cpuPercentBetween", () => {
  it("turns a cumulative sample into a share of one core", () => {
    // 500 ms of CPU time over a 5 s wall-clock window = 10% of one core.
    expect(cpuPercentBetween(1_000_000, 1_500_000, 5)).toBeCloseTo(10);
  });

  it("can exceed 100 when several threads are busy", () => {
    // 2 s of CPU time in a 1 s window: two cores' worth.
    expect(cpuPercentBetween(0, 2_000_000, 1)).toBeCloseTo(200);
  });

  it("reports nothing when the readings cannot be compared", () => {
    expect(cpuPercentBetween(1_000, 1_000, 0)).toBeNull(); // no time passed
    expect(cpuPercentBetween(1_000, 900, 5)).toBeNull(); // counter went backwards
    expect(cpuPercentBetween(Number.NaN, 1_000, 5)).toBeNull();
    expect(cpuPercentBetween(0, 1_000, Number.NaN)).toBeNull();
  });
});

describe("buildRuntimeResponse", () => {
  const base = {
    version: "0.2.0",
    runtime: "bun/1.4.4",
    pid: 4242,
    uptimeSeconds: 91.4,
    cpuMicros: 123_456,
    cpuPercent: 12.5,
    memoryBytes: 88_000_000,
    cpuCount: 4,
    loadAverage: [0.5, 0.4, 0.3],
    freeMemoryBytes: 1_000_000,
    totalMemoryBytes: 8_000_000,
    onlineUsers: 2,
    onlineVaults: 1,
    sampledAt: new Date("2026-06-01T12:00:00.000Z"),
  };

  it("passes the sample through with a rounded uptime", () => {
    const runtime = buildRuntimeResponse(base);

    expect(runtime.uptimeSeconds).toBe(91);
    expect(runtime.cpuPercent).toBe(12.5);
    expect(runtime.memoryBytes).toBe(88_000_000);
    expect(runtime.onlineUsers).toBe(2);
    expect(runtime.onlineVaults).toBe(1);
    expect(runtime.sampledAt).toBe("2026-06-01T12:00:00.000Z");
  });

  it("keeps 'no sample yet' distinct from an idle process", () => {
    const runtime = buildRuntimeResponse({ ...base, cpuPercent: null });
    expect(runtime.cpuPercent).toBeNull();
  });

  it("always reports three load averages", () => {
    const runtime = buildRuntimeResponse({ ...base, loadAverage: [1.5] });
    expect(runtime.loadAverage).toEqual([1.5, 0, 0]);
  });

  it("never reports negative uptime or CPU time", () => {
    const runtime = buildRuntimeResponse({ ...base, uptimeSeconds: -5, cpuMicros: -10 });
    expect(runtime.uptimeSeconds).toBe(0);
    expect(runtime.cpuMicros).toBe(0);
  });
});

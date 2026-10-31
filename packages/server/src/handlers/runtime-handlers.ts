import type { AdminRuntimeResponse } from "@courier/shared";

/**
 * Build the runtime snapshot from raw values the caller read.
 *
 * Pure on purpose: the values come from `process` and `os`, which a unit test
 * cannot fake usefully — so the arithmetic (uptime, the CPU delta) is separated
 * from the reading, and the reading stays a thin block in the route.
 */

/** What the route read, before any arithmetic. */
export interface RuntimeInput {
  version: string;
  runtime: string;
  pid: number;
  /** Seconds the process has been running, as `process.uptime()` reports them. */
  uptimeSeconds: number;
  /** Cumulative user+system CPU microseconds. */
  cpuMicros: number;
  /** Percent of one core since the previous sample; null when there is none. */
  cpuPercent: number | null;
  memoryBytes: number;
  cpuCount: number;
  loadAverage: number[];
  freeMemoryBytes: number;
  totalMemoryBytes: number;
  onlineUsers: number;
  onlineVaults: number;
  sampledAt: Date;
}

export function buildRuntimeResponse(input: RuntimeInput): AdminRuntimeResponse {
  return {
    version: input.version,
    runtime: input.runtime,
    pid: input.pid,
    uptimeSeconds: Math.max(0, Math.round(input.uptimeSeconds)),
    cpuMicros: Math.max(0, Math.round(input.cpuMicros)),
    cpuPercent: input.cpuPercent,
    memoryBytes: input.memoryBytes,
    cpuCount: input.cpuCount,
    loadAverage: normalizeLoadAverage(input.loadAverage),
    freeMemoryBytes: input.freeMemoryBytes,
    totalMemoryBytes: input.totalMemoryBytes,
    onlineUsers: input.onlineUsers,
    onlineVaults: input.onlineVaults,
    sampledAt: input.sampledAt.toISOString(),
  };
}

/**
 * Percent of one core used between two cumulative CPU readings.
 *
 * Null when the readings cannot be compared (the clock did not advance, the
 * counter went backwards, or either value is unusable): a caller must show
 * "sampling" rather than a zero that looks idle. The result is a share of **one**
 * core, so a busy multi-threaded service can report more than 100.
 */
export function cpuPercentBetween(
  previousMicros: number,
  currentMicros: number,
  wallSeconds: number,
): number | null {
  if (!Number.isFinite(previousMicros) || !Number.isFinite(currentMicros)) return null;
  if (!Number.isFinite(wallSeconds) || wallSeconds <= 0) return null;
  if (currentMicros < previousMicros) return null;
  const used = (currentMicros - previousMicros) / 1_000_000;
  return Math.max(0, (used / wallSeconds) * 100);
}

/** Always three numbers, whatever `os.loadavg()` returned. */
function normalizeLoadAverage(values: number[]): [number, number, number] {
  const read = (index: number): number => {
    const value = values[index];
    return Number.isFinite(value) ? value : 0;
  };
  return [read(0), read(1), read(2)];
}

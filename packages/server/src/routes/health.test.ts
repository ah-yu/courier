import { describe, expect, it } from "vitest";
import { healthRoutes } from "./health";
import type { Logger, LogLevel } from "../lib/logger";
import type { RouteRequest } from "../http/router";

/**
 * `/api/health` on the Bun route table.
 *
 * Two things matter beyond the body: it answers without any dependency (no
 * database, no auth), and it still produces the access line — a Bun route handler
 * bypasses Hono's middleware chain, so the log is the route's own job.
 */

/** A logger that keeps the records its level would write, like the real one. */
function recordingLogger(level: LogLevel = "debug") {
  const records: Array<{ level: LogLevel; message: string }> = [];
  const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const enabled = (candidate: LogLevel) => order[candidate] >= order[level];
  const write = (candidate: LogLevel, message: string) => {
    if (enabled(candidate)) records.push({ level: candidate, message });
  };
  const logger: Logger = {
    level,
    enabled,
    debug: (message) => write("debug", message),
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
  };
  return { logger, records };
}

/** Call the table's GET the way the listener does, with no path parameters. */
function health(logger: Logger): Promise<Response> {
  const handler = healthRoutes(logger)["/api/health"]!.GET!;
  return Promise.resolve(
    handler(
      Object.assign(new Request("http://localhost/api/health"), { params: {} }) as RouteRequest,
    ),
  );
}

describe("healthRoutes", () => {
  it("answers a constant liveness body", async () => {
    const response = await health(recordingLogger("info").logger);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; timestamp: string };
    expect(body.status).toBe("ok");
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it("keeps the health poll out of the default view, and in the debug log", async () => {
    const quiet = recordingLogger("info");
    const quietResponse = await health(quiet.logger);
    expect(quietResponse.status).toBe(200);
    expect(quiet.records).toHaveLength(0);

    const loud = recordingLogger("debug");
    await health(loud.logger);
    expect(loud.records).toHaveLength(1);
    expect(loud.records[0]!.level).toBe("debug");
    expect(loud.records[0]!.message).toContain("GET /api/health 200");
  });
});

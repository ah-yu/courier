import { describe, expect, it } from "vitest";

import { AppError, RangeNotSatisfiableError, RateLimitError } from "./errors";
import { toErrorResponse } from "../http/auth";
import type { Logger, LogLevel } from "./logger";

/** A logger that keeps every record. */
function recordingLogger() {
  const records: Array<{ level: LogLevel; message: string }> = [];
  const logger: Logger = {
    level: "debug",
    enabled: () => true,
    debug: (message) => records.push({ level: "debug", message }),
    info: (message) => records.push({ level: "info", message }),
    warn: (message) => records.push({ level: "warn", message }),
    error: (message) => records.push({ level: "error", message }),
  };
  return { logger, records };
}

describe("toErrorResponse", () => {
  it("writes an app error through the logger it was given", () => {
    const { logger, records } = recordingLogger();

    const response = toErrorResponse(new AppError(403, "INSUFFICIENT_SCOPE", "no scope"), logger);

    expect(response.status).toBe(403);
    expect(records).toHaveLength(1);
    expect(records[0].level).toBe("debug");
    expect(records[0].message).toContain("403 INSUFFICIENT_SCOPE");
  });

  it("writes an unhandled error, with its stack, through the same logger", () => {
    const { logger, records } = recordingLogger();

    const response = toErrorResponse(new Error("boom"), logger);

    expect(response.status).toBe(500);
    expect(records).toHaveLength(1);
    expect(records[0].level).toBe("error");
    expect(records[0].message).toContain("boom");
  });

  it("carries the Content-Range a 416 requires", async () => {
    const { logger } = recordingLogger();
    const response = toErrorResponse(new RangeNotSatisfiableError(100), logger);

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */100");
    expect(await response.json()).toEqual({
      error: "RANGE_NOT_SATISFIABLE",
      message: "Range is not satisfiable",
    });
  });

  it("tells a rate-limited client when the window ends", async () => {
    const { logger } = recordingLogger();
    const response = toErrorResponse(
      new RateLimitError("Rate limit exceeded. Please try again in 30 seconds.", 30),
      logger,
    );

    expect(response.status).toBe(429);
    // Standard `Retry-After`: a client that binds a large vault waits exactly this long
    // instead of guessing the limiter's window.
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.json()).toMatchObject({ error: "RATE_LIMITED" });
  });

  it("sends no Retry-After when the caller did not state one", () => {
    const { logger } = recordingLogger();
    const response = toErrorResponse(new RateLimitError(), logger);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeNull();
  });
});

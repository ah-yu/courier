import { describe, expect, it } from "vitest";
import { logPushResults } from "./push-log";
import type { Logger, LogLevel } from "./logger";
import type { SyncPushResult } from "@courier/shared";

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

const ok = (fileId: string): SyncPushResult => ({ fileId, status: "ok" });

describe("logPushResults", () => {
  it("says nothing when every file was accepted", () => {
    const { logger, records } = recordingLogger();
    logPushResults(logger, "vl_1", "MacBook", [ok("f1"), ok("f2")]);
    expect(records).toHaveLength(0);
  });

  it("reports the counts and the device of a refused batch", () => {
    const { logger, records } = recordingLogger();
    logPushResults(logger, "vl_1", "MacBook", [
      ok("f1"),
      { fileId: "f2", status: "stale_base", currentVersionId: "v9" },
    ]);

    expect(records).toHaveLength(1);
    expect(records[0].message).toBe("push vl_1: 1/2 refused stale_base=1 device=MacBook");
  });

  it("keeps a routine stale_base at info", () => {
    const { logger, records } = recordingLogger();
    logPushResults(logger, "vl_1", null, [{ fileId: "f1", status: "stale_base" }]);
    expect(records[0].level).toBe("info");
  });

  it("raises a missing blob to warn, because it does not resolve itself", () => {
    const { logger, records } = recordingLogger();
    logPushResults(logger, "vl_1", "iPhone", [{ fileId: "f1", status: "content_missing" }]);
    expect(records[0].level).toBe("warn");
    expect(records[0].message).toContain("content_missing=1");
  });

  it("carries the handler's error text when one was returned", () => {
    const { logger, records } = recordingLogger();
    logPushResults(logger, "vl_1", "iPhone", [
      { fileId: "f1", status: "error", error: "SQLITE_BUSY" },
      { fileId: "f2", status: "content_missing" },
    ]);
    expect(records[0].level).toBe("warn");
    expect(records[0].message).toContain('error="SQLITE_BUSY"');
    expect(records[0].message).toContain("content_missing=1");
  });

  it("names an unknown device rather than leaving a blank field", () => {
    const { logger, records } = recordingLogger();
    logPushResults(logger, "vl_1", null, [{ fileId: "f1", status: "stale_base" }]);
    expect(records[0].message).toContain("device=unknown");
  });
});

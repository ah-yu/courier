import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createLogger, parseLogLevel } from "./logger";

/** A stderr stand-in that keeps what was written to it. */
function recordingStream() {
  const chunks: string[] = [];
  return {
    chunks,
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
    text(): string {
      return chunks.join("");
    },
  };
}

describe("parseLogLevel", () => {
  it("accepts the four levels, case-insensitively", () => {
    expect(parseLogLevel("debug")).toBe("debug");
    expect(parseLogLevel("WARN")).toBe("warn");
    expect(parseLogLevel(" error ")).toBe("error");
  });

  it("falls back to info rather than failing a start", () => {
    expect(parseLogLevel("")).toBe("info");
    expect(parseLogLevel(undefined)).toBe("info");
    expect(parseLogLevel("verbose")).toBe("info");
  });
});

describe("createLogger", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "courier-log-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("drops records below the configured level", () => {
    const stderr = recordingStream();
    const logger = createLogger({ level: "warn", stderr });

    logger.debug("quiet");
    logger.info("also quiet");
    logger.warn("kept");
    logger.error("kept too");

    expect(logger.enabled("debug")).toBe(false);
    expect(logger.enabled("warn")).toBe(true);
    expect(stderr.text()).not.toContain("quiet");
    expect(stderr.text()).not.toContain("also quiet");
    expect(stderr.text()).toContain("kept");
    expect(stderr.text()).toContain("kept too");
  });

  it("writes one JSON object per record to the file", () => {
    const stderr = recordingStream();
    const file = join(dir, "logs", "courier.log");
    const logger = createLogger({ level: "debug", file, stderr });

    logger.info("POST /api/vaults/vl_1/sync/push 200 34ms");
    logger.warn("push vl_1: 1/2 refused stale_base=1 device=MacBook");

    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.level).toBe("info");
    expect(first.msg).toContain("POST /api/vaults");
    expect(typeof first.t).toBe("string");
    expect(Number.isNaN(Date.parse(first.t))).toBe(false);
    expect(JSON.parse(lines[1]).level).toBe("warn");
  });

  it("keeps a multi-line message on one line in the file", () => {
    const stderr = recordingStream();
    const file = join(dir, "courier.log");
    const logger = createLogger({ level: "debug", file, stderr });

    logger.error("Unhandled error: boom\n    at handler (sync.ts:1:1)");

    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).msg).toContain("at handler");
    // stderr keeps the newline: a stack trace is meant to be read in full.
    expect(stderr.text()).toContain("at handler");
  });

  it("rotates at the size limit and keeps the configured number of files", () => {
    const stderr = recordingStream();
    const file = join(dir, "courier.log");
    const logger = createLogger({ level: "debug", file, stderr, maxBytes: 400, maxFiles: 2 });

    for (let index = 0; index < 20; index++) {
      logger.info(`record ${index} ${"x".repeat(60)}`);
    }

    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);
    // Three files at most: the live one plus `maxFiles` rotations.
    expect(existsSync(`${file}.3`)).toBe(false);
  });

  it("does not throw when the log file cannot be written", () => {
    const stderr = recordingStream();
    // A directory where the file should be makes every append fail.
    const file = join(dir, "is-a-directory");
    mkdirSync(file);
    const logger = createLogger({ level: "debug", file, stderr });

    expect(() => logger.info("still serves")).not.toThrow();
    expect(stderr.text()).toContain("still serves");

    // The sink is disabled after the first failure; later records still reach stderr.
    expect(() => logger.error("again")).not.toThrow();
    expect(stderr.text()).toContain("again");
  });

  it("writes nothing to a file when none is configured", () => {
    const stderr = recordingStream();
    const logger = createLogger({ level: "debug", stderr });
    logger.info("in memory only");
    expect(stderr.text()).toContain("in memory only");
  });
});

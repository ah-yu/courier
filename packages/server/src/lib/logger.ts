import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "fs";
import { dirname } from "path";

/**
 * The service's one logger.
 *
 * Two sinks, and each has a job:
 *
 *   - **stderr** — the line a human reads. Under systemd the unit captures it
 *     (`StandardError=journal`), so `journalctl` still shows the service's story
 *     even when the file sink is off, and a terminal run needs nothing else.
 *   - **a JSON-lines file** — the line a monitoring client reads over SSH. It is
 *     the store the deployment controls: `journalctl --user` only opens a per-UID
 *     journal file, which journald does not write for a root-owned user unit, so
 *     the journal alone cannot be the contract. One object per line keeps a
 *     multi-line message from being read as two records.
 *
 * A level gates **both** sinks, so `LOG_LEVEL=debug` is what turns the per-request
 * access log on. Logging never interrupts serving: a file that cannot be written
 * disables the file sink and leaves stderr alone.
 */

/** The levels, most severe last. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Read `LOG_LEVEL`, falling back to `info` for anything unrecognised. */
export function parseLogLevel(raw: string | undefined): LogLevel {
  const text = (raw ?? "").trim().toLowerCase();
  return text === "debug" || text === "info" || text === "warn" || text === "error" ? text : "info";
}

export interface Logger {
  readonly level: LogLevel;
  /** Whether a record at this level would be written at all. */
  enabled(level: LogLevel): boolean;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LoggerOptions {
  /** Minimum level written; defaults to `info`. */
  level?: LogLevel;
  /** JSON-lines file. Empty (the default) keeps the file sink off. */
  file?: string;
  /** Rotate once the file would grow past this many bytes. */
  maxBytes?: number;
  /** How many rotated files to keep (`courier.log.1` … `.N`). */
  maxFiles?: number;
  /** Where human lines go; `process.stderr` unless a test substitutes it. */
  stderr?: { write(chunk: string): unknown };
  now?: () => Date;
}

/** One written record, in the shape both sinks derive from. */
interface Record_ {
  level: LogLevel;
  message: string;
  at: Date;
}

/** `HH:MM:SS`, local — systemd prefixes its own date and host. */
function clock(at: Date): string {
  return at.toTimeString().slice(0, 8);
}

/**
 * Human line. The message keeps its own newlines on purpose — a stack trace is
 * the one record worth reading in full, and systemd stores one multi-line write as
 * one journal entry. Only the trailing newline is folded, so a record never adds a
 * blank line. The JSON sink escapes the newlines instead, because that file is read
 * line by line.
 */
function human(record: Record_): string {
  return `${clock(record.at)} ${record.level.padEnd(5)} ${record.message.replace(/\n+$/, "")}\n`;
}

/** One JSON object on one line; `JSON.stringify` escapes any newline inside. */
function jsonLine(record: Record_): string {
  return (
    JSON.stringify({
      t: record.at.toISOString(),
      level: record.level,
      msg: record.message,
    }) + "\n"
  );
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const threshold = SEVERITY[level];
  const file = options.file ?? "";
  const maxBytes = Math.max(256, options.maxBytes ?? 5 * 1024 * 1024);
  const maxFiles = Math.max(1, options.maxFiles ?? 3);
  const stderr = options.stderr ?? process.stderr;
  const now = options.now ?? (() => new Date());

  /** Bytes in the file, measured once and then kept in step with the writes. */
  let fileBytes = -1;
  let fileBroken = false;

  const enabled = (candidate: LogLevel): boolean => SEVERITY[candidate] >= threshold;

  /**
   * Shift `courier.log` to `.1`, `.1` to `.2` and so on, dropping the oldest.
   * Called only when the next write would cross `maxBytes`, so a quiet service
   * never rotates on a timer.
   */
  function rotate(): void {
    rmSync(`${file}.${maxFiles}`, { force: true });
    for (let index = maxFiles - 1; index >= 1; index--) {
      const from = `${file}.${index}`;
      if (existsSync(from)) renameSync(from, `${file}.${index + 1}`);
    }
    renameSync(file, `${file}.1`);
  }

  function append(sinkFile: string, line: string): void {
    if (sinkFile === "" || fileBroken) return;
    try {
      if (fileBytes < 0) {
        mkdirSync(dirname(sinkFile), { recursive: true });
        fileBytes = existsSync(sinkFile) ? statSync(sinkFile).size : 0;
      }
      const bytes = Buffer.byteLength(line);
      if (fileBytes > 0 && fileBytes + bytes > maxBytes) {
        rotate();
        fileBytes = 0;
      }
      appendFileSync(sinkFile, line);
      fileBytes += bytes;
    } catch {
      // A log write must never take the service down with it. One failure is
      // enough to know this filesystem will not take the sink; stderr remains.
      fileBroken = true;
    }
  }

  function write(candidate: LogLevel, message: string): void {
    if (!enabled(candidate)) return;
    const record: Record_ = { level: candidate, message, at: now() };
    try {
      stderr.write(human(record));
    } catch {
      // A closed stderr is not a reason to fail a request.
    }
    append(file, jsonLine(record));
  }

  return {
    level,
    enabled,
    debug: (message) => write("debug", message),
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
  };
}

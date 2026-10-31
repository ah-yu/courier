import { config } from "../config";
import { createLogger, parseLogLevel } from "./logger";

/**
 * The process-wide logger, configured from the environment.
 *
 * It is created once per process rather than per request: the file handle's byte
 * counter and the rotation state belong to the running service, and a logger per
 * call site would rotate the same file from several counters.
 *
 * `LOG_FILE` is empty by default so that a test run and the L1/L2 harnesses never
 * write a log file; the deployed unit sets it (`~/courier/logs/courier.log`), and
 * that path is also what a monitoring client reads over SSH.
 */
export const logger = createLogger({
  level: parseLogLevel(config.LOG_LEVEL),
  file: config.LOG_FILE,
  maxBytes: config.LOG_MAX_BYTES,
  maxFiles: config.LOG_MAX_FILES,
});

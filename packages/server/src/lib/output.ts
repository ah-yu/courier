/**
 * CLI output contract:
 *   - stdout — machine-readable command results only (JSON, tables, raw
 *     values consumed by deploy tooling)
 *   - stderr — human-readable status/diagnostics (never parsed by callers)
 *
 * oxlint's `no-console` override for this package forbids `console.log`, so
 * stray debug logging can never pollute machine-readable output. Under
 * systemd both streams are captured by journald (StandardOutput/Error=journal).
 */

/** Machine-readable command results → stdout. */
export function output(line: string): void {
  process.stdout.write(line + "\n");
}

/** Human-readable status/diagnostics → stderr. */
export function info(line: string): void {
  process.stderr.write(line + "\n");
}

/**
 * The JavaScript runtime this process is executing on, as `name/version`.
 *
 * Courier is built and run with Bun. `process.versions.bun` names it; the plugin's
 * runtime is Electron, which reports its own version and no Bun one, so the two
 * branches keep the helper total without ever naming a runtime the process is not
 * on — `process.version` is a compatibility label, which is why it is never read.
 *
 * The versions bag is an argument rather than a read of the global `process`:
 * `@courier/shared` is also bundled into the plugin, which declares no runtime types
 * and may have no `process` at all, so this module makes no runtime assumption and
 * each caller passes what its own runtime reports.
 */
export function runtimeLabel(versions?: Record<string, string | undefined>): string {
  if (!versions) return "unknown";
  if (versions.bun) return `bun/${versions.bun}`;
  if (versions.electron) return `electron/${versions.electron}`;
  return "unknown";
}

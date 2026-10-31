/**
 * The JavaScript runtime this process is executing on, as `name/version`.
 *
 * Courier is built and run with Bun. `process.versions.bun` names it; the plugin's
 * runtime is Electron, which reports its own version and no Bun one, so the two
 * branches keep the helper total without ever naming a runtime the process is not
 * on — `process.version` is a compatibility label, which is why it is never read.
 *
 * Read through `globalThis` rather than the bare identifier: `@courier/shared`
 * declares no runtime types on purpose (it is also bundled into the plugin), so
 * `process` is not a known global there.
 */
export function runtimeLabel(): string {
  const proc = (globalThis as { process?: { versions?: Record<string, string | undefined> } })
    .process;
  const versions = proc?.versions;
  if (!versions) return "unknown";
  if (versions.bun) return `bun/${versions.bun}`;
  if (versions.electron) return `electron/${versions.electron}`;
  return "unknown";
}

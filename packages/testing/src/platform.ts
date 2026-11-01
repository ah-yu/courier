/**
 * The runtime the suites run the engine on.
 *
 * The suites run under Bun (`bun --bun vitest`), so this is the Web surface with `unref`
 * on the timers: a test that scheduled a reconnect still finishes when it has nothing
 * else to do. It is a **test** platform, not a shipped default — the engine names no
 * global of its own, and a host states its runtime explicitly.
 *
 * Deliberately *not* annotated as `Platform`: this package sits below `@courier/engine`
 * in the dependency graph (engine depends on this package for its own tests), so naming
 * that type here would close a cycle for the sake of one annotation. The shape is
 * checked where it is used — every construction site passes it as `platform: Platform`.
 */
export const realPlatform = {
  after(ms: number, fn: () => void) {
    const timer = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(timer), unref: () => timer.unref() };
  },
  every(ms: number, fn: () => void) {
    const timer = setInterval(fn, ms);
    return { cancel: () => clearInterval(timer), unref: () => timer.unref() };
  },
  process,
};

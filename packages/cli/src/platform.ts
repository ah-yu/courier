import type { Platform } from "@courier/engine";

/**
 * The CLI's runtime surface: Bun.
 *
 * The timers are the Web ones — they exist, so nothing is re-implemented — but they are
 * `unref`d where the engine asks for it. A daemon that scheduled a periodic reconcile
 * must still exit when nothing else holds the event loop open; Obsidian's renderer has no
 * such notion, which is why that half stays optional in `TimerHandle`.
 *
 * `process` is the real one. The lease reads `pid`, `env` and `kill` through it, which is
 * how a holder whose process is gone stops being described as the writer.
 */
export const cliPlatform: Platform = {
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(timer), unref: () => timer.unref() };
  },
  every(ms, fn) {
    const timer = setInterval(fn, ms);
    return { cancel: () => clearInterval(timer), unref: () => timer.unref() };
  },
  process,
};

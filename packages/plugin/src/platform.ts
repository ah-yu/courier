import type { Platform } from "@courier/engine";

/**
 * The plugin's runtime surface: Obsidian's renderer.
 *
 * Timers are created **on `window`**, not through the bare globals: that is the shape
 * Obsidian's plugin guidelines ask for (`obsidianmd/prefer-window-timers`), and it is
 * also what the CLI cannot do — which is the whole reason this is a port rather than a
 * global.
 *
 * There is no `unref` here: the app is kept alive by its windows, not by a pending timer,
 * so the handle has nothing to do on the way out.
 *
 * `process` hangs off the window in Electron — the renderer has Node integration, which
 * is what lets a plugin `require` — and is absent on mobile, which is exactly the
 * "maybe there is no process table" case `NodeSurface` allows for. The lease reads it
 * through {@link Platform.process}, so the plugin keeps the same stale-holder evidence
 * the CLI has on desktop.
 */
export const pluginPlatform: Platform = {
  after(ms, fn) {
    const id = window.setTimeout(fn, ms);
    return { cancel: () => window.clearTimeout(id) };
  },
  every(ms, fn) {
    const id = window.setInterval(fn, ms);
    return { cancel: () => window.clearInterval(id) };
  },
  get process() {
    return (window as unknown as { process?: Platform["process"] }).process;
  },
};

import type { SyncEngine } from "@courier/engine";
import type { PluginActions } from "./api";
import type { CourierSettings } from "./settings";

/**
 * What a **read-only** panel or dialog needs from the plugin.
 *
 * The recycle bin, the sync history and the version-history view used to depend on the concrete
 * `CourierPlugin` class, which meant a UI test had to build a whole plugin — Obsidian
 * lifecycle, network wiring and all — to render a list. They need four things, and this
 * is the interface that says so. `CourierPlugin` satisfies it structurally, so nothing
 * has to be registered or adapted.
 *
 * Deliberately **not** here: `saveSettings`, the scope setters and the sign-in flows. A
 * panel that writes settings is a panel that should be going through the plugin's own
 * intent methods (see `setFileTypeEnabled` and friends), not reaching into state.
 */
export interface CourierUiHost {
  settings: CourierSettings;
  /** The vault key in memory, or null while this device is locked. */
  encryptionKey: CryptoKey | null;
  /** The plugin's network actions (vault list, history, version content). */
  actions: PluginActions;
  /** The running engine, or null while no host is up. */
  engine: SyncEngine | null;
}

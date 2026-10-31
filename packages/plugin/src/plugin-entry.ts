import CourierPlugin from "./main";

/**
 * Bundle entry — deliberately a separate file from `main.ts`.
 *
 * `main.ts` exports the plugin class **and** `buildActions()` (the `requestUrl`
 * wiring), because the end-to-end suite drives that wiring directly. Using it as
 * the bundler entry makes the bundle mix a default and a named export, so
 * `module.exports` becomes `{ default, buildActions }` — not the single default
 * export Obsidian's plugin loader expects.
 *
 * Exporting only the class here keeps `dist/main.js` a plain
 * `module.exports = CourierPlugin`.
 */
export default CourierPlugin;

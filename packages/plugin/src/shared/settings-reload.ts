import type { SettingsGroup } from "@courier/engine";
import { t } from "../i18n";

/**
 * The settings the running app does not pick up on its own, and what the user is told
 * about them.
 *
 * One list, two readers: the per-switch line under a settings row, and the popup that
 * appears when a peer's copy of one of those files lands. They must agree — a switch
 * that warns a reload is needed and a popup that never comes (or the reverse) is how a
 * working sync reads as a broken one.
 *
 * **Measured against a real Obsidian, not taken from a document.** The split is not the
 * obvious one: the app does watch its config folder, and `app.json`, `hotkeys.json`, a
 * theme *name* in `appearance.json` and the *list* of snippet files take effect while it
 * runs — while a theme folder that arrives, the snippet **enable** list in that same
 * `appearance.json`, a core plugin's state and a community plugin's install/enable are
 * read once, at start-up. `sync.obsidian.test.ts` ("applies the settings the app watches
 * live…") asserts exactly that split, so a release that changes its mind fails that case
 * instead of silently making these hints lie.
 */
export const SETTINGS_GROUPS_NEEDING_RELOAD: readonly SettingsGroup[] = [
  "themes",
  "snippets",
  "corePlugins",
  "communityPluginList",
  "communityPlugins",
];

/** Whether a group's applied state needs the app to be reloaded before the user sees it. */
export function settingsGroupNeedsReload(group: SettingsGroup): boolean {
  return SETTINGS_GROUPS_NEEDING_RELOAD.includes(group);
}

/**
 * What the card says.
 *
 * Deliberately names **no** file. A peer can change several settings at once, and which
 * file changed is the sync history's job — what the user has to decide here is whether to
 * reload now, so the card says where the change came from (another device), that it did
 * arrive, and what it takes to see it. Attributing it to this device or listing paths only
 * invites the reading "so nothing is wrong with my phone".
 */
export function reloadPopupTitle(): string {
  return t("reload.title");
}

export function reloadPopupMessage(): string {
  return t("reload.message");
}

export function reloadPopupReload(): string {
  return t("reload.reload");
}

export function reloadPopupDismiss(): string {
  return t("reload.dismiss");
}

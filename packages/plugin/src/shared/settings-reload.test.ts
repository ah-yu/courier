import { beforeEach, describe, expect, it } from "vitest";
import { SETTINGS_GROUPS, type SettingsGroup } from "@courier/engine";
import { sortedCopy } from "@courier/shared";
import { setLocale } from "../i18n";
import {
  SETTINGS_GROUPS_NEEDING_RELOAD,
  reloadPopupDismiss,
  reloadPopupMessage,
  reloadPopupReload,
  reloadPopupTitle,
  settingsGroupNeedsReload,
} from "./settings-reload";

beforeEach(() => setLocale("zh"));

/**
 * The one list that tells a user a reload is coming.
 *
 * Pinned because two readers depend on it — the line under a settings switch and the popup
 * that appears when such a file arrives — and because the membership is a *measured*
 * property of Obsidian, not a preference: changing it means re-running the real-app case
 * that measures the split (`sync.obsidian.test.ts`).
 */
describe("settingsGroupNeedsReload", () => {
  const RELOAD: SettingsGroup[] = [
    "themes",
    "snippets",
    "corePlugins",
    "communityPluginList",
    "communityPlugins",
  ];
  /** The groups a running Obsidian applies on its own — asserting a reload for one of these
   * would teach the user to dismiss the popup without reading it. */
  const HOT: SettingsGroup[] = ["app", "appearance", "hotkeys", "corePluginSettings", "otherFiles"];

  it("covers every switch exactly once — a group, not a path", () => {
    expect(sortedCopy(SETTINGS_GROUPS_NEEDING_RELOAD)).toEqual(sortedCopy(RELOAD));
    for (const group of SETTINGS_GROUPS) {
      expect(
        [RELOAD, HOT].filter((list) => list.includes(group)),
        group,
      ).toHaveLength(1);
    }
  });

  it("answers for the reload groups and for nothing else", () => {
    for (const group of RELOAD) {
      expect(settingsGroupNeedsReload(group), group).toBe(true);
    }
    for (const group of HOT) {
      expect(settingsGroupNeedsReload(group), group).toBe(false);
    }
  });

  it("says a reload is the way to see the change, without naming a file", () => {
    expect(reloadPopupTitle()).not.toBe("");
    expect(reloadPopupMessage()).toContain("重新加载");
    expect(reloadPopupReload()).toBe("重新加载");
    expect(reloadPopupDismiss()).not.toBe("");
    // The change came from a peer: saying which file, or what it now holds, is the sync
    // history's job and invites "so the rest did not arrive".
    expect(reloadPopupMessage()).not.toMatch(/\.json|\.css|\.obsidian|plugins\//);
  });
});

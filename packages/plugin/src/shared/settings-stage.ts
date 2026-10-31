/**
 * Which of the settings page's steps to show.
 *
 * The page derives this from real state on **every** render — there is no persisted
 * session flag and no step counter — which makes the rule worth stating once, outside the
 * DOM: it is the whole navigation model of the plugin's only settings surface, and it used
 * to be four `if`s inside a 600-line `render` file where nothing could test it.
 */
export type SettingsStage = "login" | "choose" | "ready" | "locked" | "unverified";

export interface SettingsStageInput {
  /** The account credential, or null while signed out. */
  userKey: string | null;
  /** The remote vault this device is bound to, or null before one is chosen. */
  connectedVaultId: string | null;
  /**
   * Whether syncing is paused.
   *
   * A paused binding is still a binding, so the page shows the settings — even after a
   * restart, where a paused load deliberately does not unlock the vault (that would mean
   * asking for a password the pause exists to avoid). Resuming is a button on the page.
   */
  paused: boolean;
  /** Whether the vault key is in memory (unlocked) — not whether it is stored. */
  unlocked: boolean;
  /**
   * A **failed** sign-in sets this: the key is saved before it is proved (so the vault
   * step would otherwise already be showing), and the user has to see the form they just
   * submitted, with the error under it, rather than a step that assumes it worked.
   */
  showLogin: boolean;
  /**
   * Whether this device holds a stored key for the bound vault.
   *
   * Presence, not usability: whether the key actually opens the vault is only discovered
   * when the server check runs.
   *
   * It splits the "bound, but the key is not in memory" state in two, because the two need
   * different actions. With a stored key the password is not what is missing — the check
   * against the server is, so the page offers a retry. Without one there is nothing to
   * check and the user has to type the password.
   */
  hasStoredCredential: boolean;
}

export function settingsStage(input: SettingsStageInput): SettingsStage {
  // Order matters: a failed sign-in wins over a key that is already saved, and "no key"
  // wins over "no vault" — the vault list cannot be fetched without one.
  if (input.showLogin) return "login";
  if (!input.userKey) return "login";
  if (!input.connectedVaultId) return "choose";
  // A paused binding is still bound: the page shows the settings, including the row that
  // resumes syncing. It must not fall through to `locked` — a paused load never unlocks,
  // and asking for the password here is exactly what pausing avoids.
  if (input.paused) return "ready";
  // Bound, and the key is either in memory (ready) or needs something from the user.
  // Neither remaining step is an error state: `unverified` is what a stored key that this
  // run could not prove looks like, and `locked` is what reopening Obsidian shows when the
  // device holds no key at all.
  if (input.unlocked) return "ready";
  // The key is on this device and only its server check could not be made (an offline
  // start, a server that is briefly down): the password would not help, because it cannot
  // be proved either. `unverified` offers the retry that runs the stored-key path again.
  return input.hasStoredCredential ? "unverified" : "locked";
}

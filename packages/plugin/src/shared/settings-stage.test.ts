import { describe, expect, it } from "vitest";
import { settingsStage, type SettingsStageInput } from "./settings-stage";

/**
 * The settings page's navigation model.
 *
 * A handful of `if`s that used to live inside a 600-line render file, where no test could
 * reach them: the page is driven at L2 through a stub DOM, so a change to this rule was only
 * ever caught if a case happened to click through that exact combination of state. It is the
 * whole navigation of the plugin's only settings surface, so it is stated once, outside the
 * DOM, and pinned here — including the two orderings that are easy to get wrong.
 */

function input(overrides: Partial<SettingsStageInput> = {}): SettingsStageInput {
  return {
    userKey: "ck_user",
    connectedVaultId: "v1",
    paused: false,
    unlocked: true,
    showLogin: false,
    hasStoredCredential: false,
    ...overrides,
  };
}

describe("settingsStage", () => {
  it("asks for the key when there is none", () => {
    expect(settingsStage(input({ userKey: null }))).toBe("login");
  });

  it("asks for the key before it asks for a vault — the list needs the key", () => {
    expect(settingsStage(input({ userKey: null, connectedVaultId: null }))).toBe("login");
  });

  it("offers the vault list once signed in but unbound", () => {
    expect(settingsStage(input({ connectedVaultId: null }))).toBe("choose");
  });

  it("shows the settings when bound and unlocked", () => {
    expect(settingsStage(input())).toBe("ready");
  });

  it("shows the unlock step when bound but locked — not an error, a step", () => {
    expect(settingsStage(input({ unlocked: false }))).toBe("locked");
  });

  it("keeps the locked step even while the key is missing from memory", () => {
    // The two are independent: `unlocked` is "the key is in memory", not "the key is
    // stored". A device whose stored credential is dead still shows `locked`, which is
    // what offers the password dialog.
    expect(settingsStage(input({ unlocked: false }))).toBe("locked");
    expect(settingsStage(input({ unlocked: false, connectedVaultId: null }))).toBe("choose");
  });

  it("offers the retry, not the password, when the key is stored but not in memory", () => {
    // A stored key means the password is not what is missing — the server check is, and a
    // password cannot be proved without that same server. Asking for one sent the user to
    // a dialog that could not succeed.
    expect(settingsStage(input({ unlocked: false, hasStoredCredential: true }))).toBe("unverified");
    // Nothing stored: there is nothing to retry, so the password dialog is the way in.
    expect(settingsStage(input({ unlocked: false, hasStoredCredential: false }))).toBe("locked");
  });

  it("a stored key never overrides an unlocked vault, a pause or a missing account", () => {
    expect(settingsStage(input({ hasStoredCredential: true }))).toBe("ready");
    expect(settingsStage(input({ paused: true, unlocked: false, hasStoredCredential: true }))).toBe(
      "ready",
    );
    expect(settingsStage(input({ userKey: null, hasStoredCredential: true }))).toBe("login");
    expect(settingsStage(input({ connectedVaultId: null, hasStoredCredential: true }))).toBe(
      "choose",
    );
  });

  it("shows the settings while paused, even with no key in memory", () => {
    // A paused load deliberately does not unlock the vault (that is what keeps the
    // password out of a pause), so `unlocked` is false — but the page is not `locked`:
    // it is the settings, with the row that resumes syncing.
    expect(settingsStage(input({ paused: true }))).toBe("ready");
    expect(settingsStage(input({ paused: true, unlocked: false }))).toBe("ready");
    // Pause belongs to a binding: without one there is nothing to pause.
    expect(settingsStage(input({ paused: true, connectedVaultId: null }))).toBe("choose");
  });

  it("a paused page still requires the account and wins no ordering over a sign-in", () => {
    expect(settingsStage(input({ paused: true, userKey: null }))).toBe("login");
    expect(settingsStage(input({ paused: true, showLogin: true }))).toBe("login");
  });

  it("a failed sign-in wins over the key it just saved", () => {
    // `signIn()` persists the key before proving it, so without this the page would jump
    // to the vault step and the user would never see the error under the form.
    expect(settingsStage(input({ showLogin: true }))).toBe("login");
    expect(settingsStage(input({ showLogin: true, connectedVaultId: null }))).toBe("login");
    expect(settingsStage(input({ showLogin: true, unlocked: false }))).toBe("login");
  });

  it("a failed sign-in also wins when the key was rejected outright", () => {
    expect(settingsStage(input({ showLogin: true, userKey: null }))).toBe("login");
  });
});

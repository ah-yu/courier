import { describe, expect, it, vi } from "vitest";
import { unbindVault, type SessionHost } from "./session";
import {
  loadVaultCredential,
  saveVaultCredential,
  type CredentialStoreHost,
} from "./credential-store";
import { DEFAULT_SETTINGS, type CourierSettings } from "./settings";

/**
 * Letting go of a vault.
 *
 * Four flows run this — disconnect, logout, "the vault is gone", "your key was revoked" —
 * and each used to clear the fields by hand, so a field added later was cleared in two of
 * the four. What the tests pin is the one difference between them (the account) and what
 * is deliberately kept (the server URL and the device label: logging back in is then one
 * field, not three).
 */

function fakeApp(): CredentialStoreHost & { readonly stored: Map<string, unknown> } {
  const stored = new Map<string, unknown>();
  return {
    stored,
    loadLocalStorage: (key) => stored.get(key) ?? null,
    saveLocalStorage: (key, data) => {
      if (data === null) stored.delete(key);
      else stored.set(key, data);
    },
  };
}

function sessionHost(settings: CourierSettings): SessionHost & {
  stopped: number;
  forgotKey: number;
  saves: number;
} {
  const state = { stopped: 0, forgotKey: 0, saves: 0 };
  return {
    settings,
    get stopped() {
      return state.stopped;
    },
    get forgotKey() {
      return state.forgotKey;
    },
    get saves() {
      return state.saves;
    },
    stopHost: vi.fn(() => {
      state.stopped++;
    }),
    forgetKey: vi.fn(() => {
      state.forgotKey++;
    }),
    saveSettings: vi.fn(async () => {
      state.saves++;
    }),
  };
}

function boundSettings(overrides: Partial<CourierSettings> = {}): CourierSettings {
  return {
    ...DEFAULT_SETTINGS,
    serverUrl: "http://srv",
    userKey: "ck_x",
    userName: "Alice",
    deviceName: "MacBook",
    connectedVaultId: "v1",
    connectedVaultName: "notes",
    encryptionSalt: "salt",
    accountMaxFileBytes: 7 * 1024 * 1024,
    vaultConnections: {
      v1: { deviceName: "MacBook", excludedFolders: [] },
    },
    syncState: {
      localVersions: {
        f1: { lastKnownVersionId: "x", lastKnownContentHash: "h", plainPath: "a.md" },
      },
    },
    ...overrides,
  };
}

describe("unbindVault", () => {
  it("stops the host, drops the binding and the stored key, and keeps the account", async () => {
    const app = fakeApp();
    saveVaultCredential(app, "v1", "a2V5");
    const host = sessionHost(boundSettings());

    await unbindVault(app, host);

    expect(host.stopped).toBe(1);
    expect(host.forgotKey).toBe(1);
    expect(host.saves).toBe(1);
    expect(host.settings.connectedVaultId).toBeNull();
    expect(host.settings.connectedVaultName).toBeNull();
    expect(host.settings.encryptionSalt).toBeNull();
    expect(host.settings.syncState).toBeUndefined();
    // "Switch vault": the key and the account name stay.
    expect(host.settings.userKey).toBe("ck_x");
    expect(host.settings.userName).toBe("Alice");
    // The per-key file cap belongs to the account that is staying.
    expect(host.settings.accountMaxFileBytes).toBe(7 * 1024 * 1024);
    // The server URL and the device label are not credentials.
    expect(host.settings.serverUrl).toBe("http://srv");
    expect(host.settings.deviceName).toBe("MacBook");
    // The per-vault record survives too — including a record whose folder list is empty,
    // which is how "configured, nothing excluded" is remembered for the next connect.
    expect(host.settings.vaultConnections).toEqual({
      v1: { deviceName: "MacBook", excludedFolders: [] },
    });
    // The device-local key went with the binding.
    expect(loadVaultCredential(app, "v1")).toBeNull();
  });

  it("forgets the account too when asked", async () => {
    const app = fakeApp();
    const host = sessionHost(boundSettings());

    await unbindVault(app, host, { forgetAccount: true });

    expect(host.settings.userKey).toBeNull();
    expect(host.settings.userName).toBeNull();
    // The cap belonged to that key's account.
    expect(host.settings.accountMaxFileBytes).toBe(DEFAULT_SETTINGS.accountMaxFileBytes);
    // …and still keeps what is not a credential.
    expect(host.settings.serverUrl).toBe("http://srv");
    expect(host.settings.deviceName).toBe("MacBook");
    expect(host.settings.vaultConnections).toEqual({
      v1: { deviceName: "MacBook", excludedFolders: [] },
    });
  });

  it("clears a stored key even when no vault was bound", async () => {
    const app = fakeApp();
    saveVaultCredential(app, "v1", "a2V5");
    const host = sessionHost(boundSettings({ connectedVaultId: null }));

    await unbindVault(app, host, { forgetAccount: true });

    expect(loadVaultCredential(app, "v1")).toBeNull();
    expect(host.settings.connectedVaultId).toBeNull();
  });

  it("leaves a paused vault unpaused, so the next connection syncs", async () => {
    // A pause belongs to the binding: unbinding takes it with the binding, which is what
    // makes connecting a vault again (or another one) start syncing instead of silently
    // staying paused.
    const host = sessionHost(boundSettings({ syncPaused: true }));

    await unbindVault(fakeApp(), host);

    expect(host.settings.syncPaused).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  clearVaultCredential,
  loadVaultCredential,
  saveVaultCredential,
  VAULT_CREDENTIAL_KEY,
  type CredentialStoreHost,
} from "./credential-store";

/** In-memory `App` localStorage, in the injected-actions style the repo uses. */
function makeHost(initial: unknown = null) {
  let stored: unknown = initial;
  const host: CredentialStoreHost = {
    loadLocalStorage: vi.fn(() => stored),
    saveLocalStorage: vi.fn((_key: string, data: unknown | null) => {
      stored = data;
    }),
  };
  return { host, read: () => stored };
}

describe("credential store — device-local vault key", () => {
  it("round-trips a credential for the same vault", () => {
    const { host, read } = makeHost();

    saveVaultCredential(host, "vault-1", "a2V5");
    expect(host.saveLocalStorage).toHaveBeenCalledWith(VAULT_CREDENTIAL_KEY, {
      vaultId: "vault-1",
      encryptionKeyB64: "a2V5",
    });

    expect(loadVaultCredential(host, "vault-1")).toEqual({
      vaultId: "vault-1",
      encryptionKeyB64: "a2V5",
    });
    expect(read()).toEqual({ vaultId: "vault-1", encryptionKeyB64: "a2V5" });
  });

  it("returns null when nothing is stored", () => {
    const { host } = makeHost();
    expect(loadVaultCredential(host, "vault-1")).toBeNull();
  });

  it("drops a malformed record and returns null", () => {
    const { host } = makeHost({ nope: true });
    expect(loadVaultCredential(host, "vault-1")).toBeNull();
    // The bad entry is cleared, so the next start is the plain prompt.
    expect(host.saveLocalStorage).toHaveBeenCalledWith(VAULT_CREDENTIAL_KEY, null);
  });

  it("drops an empty key rather than importing it", () => {
    const { host } = makeHost({ vaultId: "vault-1", encryptionKeyB64: "" });
    expect(loadVaultCredential(host, "vault-1")).toBeNull();
    expect(host.saveLocalStorage).toHaveBeenCalledWith(VAULT_CREDENTIAL_KEY, null);
  });

  it("refuses a credential belonging to another vault", () => {
    const { host } = makeHost({ vaultId: "other-vault", encryptionKeyB64: "a2V5" });
    expect(loadVaultCredential(host, "vault-1")).toBeNull();
    expect(host.saveLocalStorage).toHaveBeenCalledWith(VAULT_CREDENTIAL_KEY, null);
  });

  it("clears by writing null", () => {
    const { host, read } = makeHost({ vaultId: "vault-1", encryptionKeyB64: "a2V5" });
    clearVaultCredential(host);
    expect(host.saveLocalStorage).toHaveBeenCalledWith(VAULT_CREDENTIAL_KEY, null);
    expect(read()).toBeNull();
  });

  it("survives a host whose localStorage throws", () => {
    // The failure path logs on purpose; keep the test output clean.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const host: CredentialStoreHost = {
      loadLocalStorage: () => {
        throw new Error("no storage");
      },
      saveLocalStorage: () => {
        throw new Error("no storage");
      },
    };
    expect(loadVaultCredential(host, "vault-1")).toBeNull();
    // Neither call may propagate: the unlock path must keep working.
    expect(() => saveVaultCredential(host, "vault-1", "a2V5")).not.toThrow();
    expect(() => clearVaultCredential(host)).not.toThrow();
    consoleError.mockRestore();
  });
});

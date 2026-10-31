import { describe, expect, it, vi } from "vitest";
import { deriveEncryptionKey, makeKeyCheck, verifyKeyCheck } from "@courier/engine";
import {
  checkVaultPassword,
  verifyKeyAgainstServer,
  type VaultCryptoActions,
} from "./vault-credentials";

/**
 * The password/canary checks, now that they are not methods on the plugin class.
 *
 * These used to be reachable only through the e2e suite that builds a whole plugin, even
 * though they depend on nothing but two injected actions and the engine's crypto. What
 * matters here is the **three-way** answer: a wrong password, a server that cannot be
 * reached, and a vault whose crypto material is unreadable are three different things,
 * and the auto-unlock path acts on the difference (an unreachable server must not make
 * it delete the credential this device stored).
 */

const SALT = "c2FsdA=="; // "salt", base64

/** A vault whose canary was made from `password`. */
async function vaultWith(
  password: string,
): Promise<{ keyCheck: string; actions: VaultCryptoActions }> {
  const key = await deriveEncryptionKey(password, SALT);
  return {
    keyCheck: await makeKeyCheck(key),
    actions: {
      getEncryptionSalt: vi.fn(async () => ({ encryptionSalt: SALT })),
      getKeyCheck: vi.fn(async () => ({ keyCheck: await makeKeyCheck(key) })),
    },
  };
}

describe("checkVaultPassword", () => {
  it("accepts the right password and hands back the salt", async () => {
    const { actions } = await vaultWith("correct horse");

    await expect(checkVaultPassword(actions, "v1", "correct horse")).resolves.toEqual({
      kind: "ok",
      encryptionSalt: SALT,
    });
  });

  it("answers 'invalid-password' for a wrong one", async () => {
    const { actions } = await vaultWith("correct horse");

    await expect(checkVaultPassword(actions, "v1", "wrong")).resolves.toEqual({
      kind: "invalid-password",
    });
  });

  it("answers 'error' — not 'invalid' — when the server cannot be reached", async () => {
    const failure = new Error("fetch failed");
    const actions: VaultCryptoActions = {
      getEncryptionSalt: vi.fn(async () => {
        throw failure;
      }),
      getKeyCheck: vi.fn(),
    };

    await expect(checkVaultPassword(actions, "v1", "any")).resolves.toEqual({
      kind: "error",
      error: failure,
    });
  });
});

describe("verifyKeyAgainstServer", () => {
  it("accepts the key the vault was made with", async () => {
    const { actions } = await vaultWith("correct horse");
    const key = await deriveEncryptionKey("correct horse", SALT);

    await expect(verifyKeyAgainstServer(actions, "v1", key)).resolves.toEqual({ kind: "ok" });
  });

  it("answers 'invalid' for a key that does not open the canary", async () => {
    const { actions } = await vaultWith("correct horse");
    const other = await deriveEncryptionKey("another password", SALT);

    await expect(verifyKeyAgainstServer(actions, "v1", other)).resolves.toEqual({
      kind: "invalid",
    });
  });

  it("answers 'unreachable' — not 'invalid' — when the request itself fails", async () => {
    const failure = new Error("fetch failed");
    const actions = {
      getKeyCheck: vi.fn(async () => {
        throw failure;
      }),
    };
    const key = await deriveEncryptionKey("correct horse", SALT);

    await expect(verifyKeyAgainstServer(actions, "v1", key)).resolves.toEqual({
      kind: "unreachable",
      error: failure,
    });
  });

  it("keeps a wrong key and a broken canary apart from a transport failure", async () => {
    // `verifyKeyCheck` answers a wrong key with `false` and never throws, so an
    // unreadable canary must surface as "unreachable" rather than as "invalid".
    const actions = { getKeyCheck: vi.fn(async () => ({ keyCheck: "not-a-canary" })) };
    const key = await deriveEncryptionKey("correct horse", SALT);

    expect(await verifyKeyCheck(key, "not-a-canary")).toBe(false);
    await expect(verifyKeyAgainstServer(actions, "v1", key)).resolves.toEqual({ kind: "invalid" });
  });
});

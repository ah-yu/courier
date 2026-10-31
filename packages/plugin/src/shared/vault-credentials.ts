import { deriveEncryptionKey, verifyKeyCheck } from "@courier/engine";

/**
 * Checking a vault password (or a stored key) against the server's canary.
 *
 * The password itself never reaches the server: the client fetches the salt and the
 * key-check ciphertext, derives the key locally and asks AES-GCM whether it opens the
 * canary. These lived as methods on the plugin class, so their only coverage was the
 * e2e suite that constructs a whole plugin — even though they depend on nothing but two
 * injected actions and the engine's crypto.
 */

/** The two server reads a password check needs (the plugin's `PluginActions` satisfies this). */
export interface VaultCryptoActions {
  getEncryptionSalt(id: string): Promise<{ encryptionSalt: string }>;
  getKeyCheck(id: string): Promise<{ keyCheck: string }>;
}

/**
 * The result of checking a vault password.
 *
 * Three cases, because callers must react differently: success carries the salt they
 * need for key derivation, a wrong password means "ask again", and an error means the
 * server (or the derivation) failed — which is **not** the same answer.
 */
export type VaultCredentialCheck =
  | { kind: "ok"; encryptionSalt: string }
  | { kind: "invalid-password" }
  | { kind: "error"; error: unknown };

/**
 * Check a password against the server's salt + canary.
 *
 * It reads settings and does two network reads; it never mutates anything, so the
 * caller decides whether the salt (and the derived key) are remembered.
 */
export async function checkVaultPassword(
  actions: VaultCryptoActions,
  vaultId: string,
  password: string,
): Promise<VaultCredentialCheck> {
  let encryptionSalt: string;
  let keyCheck: string;
  try {
    encryptionSalt = (await actions.getEncryptionSalt(vaultId)).encryptionSalt;
    keyCheck = (await actions.getKeyCheck(vaultId)).keyCheck;
  } catch (error) {
    console.error("Fetching vault crypto material failed:", error);
    return { kind: "error", error };
  }

  try {
    const key = await deriveEncryptionKey(password, encryptionSalt);
    return (await verifyKeyCheck(key, keyCheck))
      ? { kind: "ok", encryptionSalt }
      : { kind: "invalid-password" };
  } catch {
    // A derivation failure is a local failure, not a server one.
    return { kind: "error", error: new Error("key derivation failed") };
  }
}

/** What a stored key turned out to be: usable, wrong, or unverifiable right now. */
export type StoredKeyCheck =
  | { kind: "ok" }
  | { kind: "invalid" }
  | { kind: "unreachable"; error: unknown };

/**
 * Check that a key this device already holds still opens the vault, using the canary.
 *
 * The third outcome is the one that matters: a **transport** failure is not "this key is
 * wrong". Collapsing the two meant a server that was briefly down made the auto-unlock
 * path delete the credential this device had stored — and then reject the password the
 * user retyped, because that check could not reach the server either.
 */
export async function verifyKeyAgainstServer(
  actions: Pick<VaultCryptoActions, "getKeyCheck">,
  vaultId: string,
  key: CryptoKey,
): Promise<StoredKeyCheck> {
  try {
    const { keyCheck } = await actions.getKeyCheck(vaultId);
    // A wrong key fails GCM authentication locally, so this answers "invalid" and is a
    // genuinely different answer from a server we never reached.
    return (await verifyKeyCheck(key, keyCheck)) ? { kind: "ok" } : { kind: "invalid" };
  } catch (err) {
    // `verifyKeyCheck` answers a wrong key with `false` and never throws, so reaching
    // here means the request itself failed: nothing could be checked at all.
    console.error("Reading the vault's key check failed:", err);
    return { kind: "unreachable", error: err };
  }
}

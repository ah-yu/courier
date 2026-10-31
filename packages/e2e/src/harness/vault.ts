import {
  deriveEncryptionKey,
  generateSalt,
  makeKeyCheck,
  verifyKeyCheck,
} from "../../../engine/src/index";
import type { TestServer } from "./server";

/**
 * Vault crypto material for a test run.
 *
 * `deriveEncryptionKey` runs PBKDF2 with 600k iterations — roughly a second of
 * CPU — so tests derive **once** and reuse the material for every vault they
 * create. That is legitimate: the salt and canary are just opaque values the
 * server stores, and reusing them keeps the suite fast.
 */
export interface VaultMaterial {
  password: string;
  salt: string;
  key: CryptoKey;
  keyCheck: string;
}

/** Derive a reusable vault key + canary from a password. */
export async function makeVaultMaterial(password = "correct horse battery staple") {
  const salt = generateSalt();
  const key = await deriveEncryptionKey(password, salt);
  const keyCheck = await makeKeyCheck(key);
  return { password, salt, key, keyCheck } satisfies VaultMaterial;
}

/** True when `password` unlocks the canary — mirrors the plugin's local check. */
export async function passwordUnlocks(material: VaultMaterial, password: string): Promise<boolean> {
  const candidate = await deriveEncryptionKey(password, material.salt);
  return await verifyKeyCheck(candidate, material.keyCheck);
}

export interface TestVault {
  id: string;
  name: string;
}

/** Create a vault over the real `POST /api/vaults` route. */
export async function createTestVault(
  server: Pick<TestServer, "serverUrl" | "userKey">,
  name: string,
  material: VaultMaterial,
): Promise<TestVault> {
  const response = await fetch(`${server.serverUrl}/api/vaults`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${server.userKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, encryptionSalt: material.salt, keyCheck: material.keyCheck }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create vault: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { id: string; name: string };
  return { id: body.id, name: body.name };
}

/** Fetch the vault list as the test user sees it. */
export async function listTestVaults(
  server: Pick<TestServer, "serverUrl" | "userKey">,
): Promise<Array<{ id: string; name: string }>> {
  const response = await fetch(`${server.serverUrl}/api/vaults`, {
    headers: { Authorization: `Bearer ${server.userKey}` },
  });
  if (!response.ok) throw new Error(`Failed to list vaults: ${response.status}`);
  return ((await response.json()) as { vaults: Array<{ id: string; name: string }> }).vaults;
}

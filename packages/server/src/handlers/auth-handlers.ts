import crypto from "crypto";
import type { ApiKeyScope, CreateApiKeyResponse, ListApiKeysResponse } from "@courier/shared";
import { generateApiKey } from "../lib/token";
import { formatScopes, parseScopes } from "../lib/api-key-access";

function maskKey(key: string): string {
  if (key.length <= 12) return key;
  const prefix = key.slice(0, 8);
  const suffix = key.slice(-4);
  return `${prefix}***********************${suffix}`;
}

// ── Action types (db operations injected by the caller) ──

/**
 * Resolves a presented `ak_` key. It carries the stored scope list and expiry,
 * because authorization is decided by the key record itself.
 */
export type FindApiKeyFn = (
  key: string,
) => Promise<{ id: string; scopes: string | null; expiresAt: string | null } | undefined>;

export type InsertApiKeyFn = (data: {
  id: string;
  name: string;
  key: string;
  /** Comma-separated scope list (see `lib/api-key-access.ts`). */
  scopes: string;
  expiresAt: string | null;
}) => Promise<{ createdAt: Date }>;

export type ListApiKeysFn = () => Promise<
  Array<{
    id: string;
    name: string;
    key: string;
    scopes: string;
    expiresAt: string | null;
    createdAt: Date;
  }>
>;

export type DeleteApiKeyFn = (id: string) => Promise<void>;

// ── Create API Key ──

export interface CreateApiKeyInput {
  name: string;
  /**
   * Capabilities for the new key. An omitted or empty list means the full-power
   * `admin` key, which is what every key created before scopes existed carries
   * (and the column's default); a host asks for `status,users`.
   */
  scopes?: readonly ApiKeyScope[];
  /** ISO 8601 expiry, or null/omitted for a key that never expires. */
  expiresAt?: string | null;
}

export async function createApiKey(
  input: CreateApiKeyInput,
  insertApiKey: InsertApiKeyFn,
): Promise<CreateApiKeyResponse> {
  const id = crypto
    .getRandomValues(new Uint8Array(32))
    .toBase64({ alphabet: "base64url", omitPadding: true });
  const key = generateApiKey();
  const scopes = formatScopes(input.scopes?.length ? input.scopes : ["admin"]) || "admin";
  const expiresAt = input.expiresAt ?? null;

  const { createdAt } = await insertApiKey({ id, name: input.name, key, scopes, expiresAt });

  return {
    id,
    name: input.name,
    key,
    scopes: parseScopes(scopes),
    expiresAt,
    createdAt: createdAt.toISOString(),
  };
}

// ── List API Keys ──

export async function listApiKeys(listFn: ListApiKeysFn): Promise<ListApiKeysResponse> {
  const apiKeys = await listFn();
  return {
    apiKeys: apiKeys.map((k) => ({
      id: k.id,
      name: k.name,
      key: maskKey(k.key),
      scopes: parseScopes(k.scopes),
      expiresAt: k.expiresAt,
      createdAt: k.createdAt.toISOString(),
    })),
  };
}

// ── Revoke API Key ──

export async function revokeApiKey(keyId: string, deleteFn: DeleteApiKeyFn): Promise<void> {
  await deleteFn(keyId);
}

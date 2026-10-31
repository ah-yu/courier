import { API_KEY_SCOPES, type ApiKeyScope } from "@courier/shared";
import { KeyExpiredError } from "./errors";
import { isExpiredAt } from "./expiry";

/**
 * Pure host-key (`ak_...`) access rules: which scopes a stored key grants,
 * whether it has expired, and how the CLI's `--scopes` / `--expires-in`
 * arguments are parsed. Kept free of DB imports so it unit-tests with plain
 * arguments, like `lib/quota.ts`.
 */

/** The scopes a stored key grants, dropping anything this binary does not know. */
export function parseScopes(raw: string | null | undefined): ApiKeyScope[] {
  if (!raw) return [];
  const known = new Set<string>(API_KEY_SCOPES);
  const granted = new Set<string>();
  for (const part of raw.split(",")) {
    const scope = part.trim();
    if (scope && known.has(scope)) granted.add(scope);
  }
  // Iterate the canonical list so the output order is stable.
  return API_KEY_SCOPES.filter((scope) => granted.has(scope));
}

/** Serialize a scope list for storage. An empty list stores an empty string. */
export function formatScopes(scopes: readonly ApiKeyScope[]): string {
  return parseScopes(scopes.join(",")).join(",");
}

/** True when the key grants `required`; `admin` implies every scope. */
export function hasScope(raw: string | null | undefined, required: ApiKeyScope): boolean {
  const scopes = parseScopes(raw);
  return scopes.includes("admin") || scopes.includes(required);
}

/** True when the key's expiry is in the past (or unparseable). */
export function isApiKeyExpired(key: { expiresAt: string | null }, now = new Date()): boolean {
  return isExpiredAt(key.expiresAt, now);
}

/** Throw KeyExpiredError if the host key has expired. */
export function assertApiKeyActive(key: { expiresAt: string | null }, now = new Date()): void {
  if (isApiKeyExpired(key, now)) {
    throw new KeyExpiredError("Host key has expired");
  }
}

/**
 * Parse a `--scopes` argument ("status,users"). Returns null when any name is
 * unknown or the list is empty, so the caller rejects the whole request instead
 * of silently granting a subset.
 */
export function parseScopeList(value: string): ApiKeyScope[] | null {
  const known = new Set<string>(API_KEY_SCOPES);
  const parsed: ApiKeyScope[] = [];
  for (const part of value.split(",")) {
    const scope = part.trim();
    if (!scope) continue;
    if (!known.has(scope)) return null;
    if (!parsed.includes(scope as ApiKeyScope)) parsed.push(scope as ApiKeyScope);
  }
  return parsed.length > 0 ? parsed : null;
}

/** Duration units `--expires-in` accepts. */
const DURATION_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a `--expires-in` duration ("30m", "12h", "7d") into an absolute ISO 8601
 * timestamp. Returns null for an unusable value.
 */
export function parseExpiresIn(value: string, now = new Date()): string | null {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return new Date(now.getTime() + amount * DURATION_MS[match[2]]).toISOString();
}

import crypto from "crypto";

export function generateVaultId(): string {
  return crypto
    .getRandomValues(new Uint8Array(32))
    .toBase64({ alphabet: "base64url", omitPadding: true });
}

const API_KEY_PREFIX = "ak_";
const USER_KEY_PREFIX = "ck_";

export function generateApiKey(): string {
  const random = crypto
    .getRandomValues(new Uint8Array(32))
    .toBase64({ alphabet: "base64url", omitPadding: true });
  return `${API_KEY_PREFIX}${random}`;
}

/** Generate a user key (`ck_...`) — the single account/sync credential per user. */
export function generateUserKey(): string {
  const random = crypto
    .getRandomValues(new Uint8Array(32))
    .toBase64({ alphabet: "base64url", omitPadding: true });
  return `${USER_KEY_PREFIX}${random}`;
}

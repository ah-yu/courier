/**
 * Whether an ISO 8601 expiry is in the past — one rule for both credentials.
 *
 * An unparseable value counts as **expired**. The two columns used to disagree
 * about exactly that: `users.expires_at` was read as `NaN <= now`, which is
 * `false`, so a corrupted row produced a key that never expired, while
 * `api_keys.expires_at` was already fail-closed. A timestamp nobody can parse is
 * not evidence that a credential is still valid, so the answer is the same on
 * both sides now — and it is the safe one.
 */
export function isExpiredAt(expiresAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!expiresAt) return false;
  const expires = new Date(expiresAt);
  if (Number.isNaN(expires.getTime())) return true;
  return expires.getTime() <= now.getTime();
}

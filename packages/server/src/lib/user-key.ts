/**
 * Mask a user key for display: keep the `ck_` prefix, the first four and the last
 * four characters, and replace the middle with `*`. The full key never appears
 * in a list response — `GET /api/users/:id/key` is the explicit reveal.
 *
 * The number of stars is fixed rather than equal to the hidden length, so the
 * mask does not leak how long the secret is.
 */
export function maskUserKey(key: string): string {
  if (key === "") return "";
  const prefix = key.startsWith("ck_") ? "ck_" : "";
  const body = prefix ? key.slice(prefix.length) : key;
  if (body.length < 10) {
    return `${prefix}${body.slice(0, 1)}****${body.slice(-1)}`;
  }
  return `${prefix}${body.slice(0, 4)}****${body.slice(-4)}`;
}

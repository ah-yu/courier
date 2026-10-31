import { decryptString } from "@courier/engine";

/**
 * The plain path a version recorded, or `null` when it cannot be decrypted.
 *
 * Three read-only surfaces — the recycle bin, the version-history view and the sync
 * history — each had their own `try { decryptString } catch { null }`, with their own
 * idea of what a missing key means. One helper: a wrong vault key (the user connected to
 * a different vault) and a corrupted row are both "this path cannot be shown", never a
 * failure that takes the whole panel down.
 */
export async function decryptPathOrNull(
  key: CryptoKey | null | undefined,
  encryptedPath: string,
): Promise<string | null> {
  if (!key) return null;
  try {
    return await decryptString(key, encryptedPath);
  } catch {
    return null;
  }
}

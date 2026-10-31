import { BLOB_HEADER_BYTES, storedChunkRegionBytes } from "@courier/shared";
import { KeyDisabledError, KeyExpiredError, QuotaExceededError } from "./errors";
import { isExpiredAt } from "./expiry";
import type { UserRow } from "../handlers/users-handlers";

/**
 * Pure quota/retention/expiry helpers, kept free of DB imports so they can be
 * unit-tested with plain arguments (matching the handler-test style).
 */

/** True when the user's key has an expiry in the past (an unparseable one counts as expired). */
export function isUserExpired(user: Pick<UserRow, "expiresAt">, now = new Date()): boolean {
  return isExpiredAt(user.expiresAt, now);
}

/**
 * Throw unless the account may authenticate at all.
 *
 * Two ways a key stops working, in this order: its validity ran out, or the host
 * disabled it. Both are refused at the route, so no handler has to remember either.
 */
export function assertUserActive(
  user: Pick<UserRow, "expiresAt" | "disabled">,
  now = new Date(),
): void {
  if (isUserExpired(user, now)) {
    throw new KeyExpiredError();
  }
  if (user.disabled) {
    throw new KeyDisabledError();
  }
}

/**
 * Throw QuotaExceededError if `current + added` would exceed the user's storage
 * limit. A null limit means unlimited.
 */
export function assertWithinQuota(
  user: Pick<UserRow, "storageBytesLimit">,
  currentBytes: number,
  addedBytes: number,
): void {
  if (user.storageBytesLimit == null) return;
  if (currentBytes + addedBytes > user.storageBytesLimit) {
    throw new QuotaExceededError();
  }
}

/**
 * How many bytes a push would add to the store.
 *
 * Only bytes that would be newly written count: a `delete` carries no content, a
 * version that reuses a stored blob pays nothing, and content the store already holds
 * costs nothing to write again (blobs are addressed by hash, so a second push of the
 * same bytes overwrites the same file). Asking `exists` per file is what keeps a peer
 * from being refused for re-pushing a note it merely moved.
 *
 * The count is what {@link writeBlob} would store: the chunk region plus the 24-byte
 * v2 header. A chunked push declares its plaintext size and chunk count instead of
 * carrying bytes, and pays for the chunks it staged plus that header.
 */
export async function incomingBytes(
  files: ReadonlyArray<{
    action: string;
    contentHash: string;
    content: Uint8Array | null;
    contentChunks?: number;
    sizeBytes?: number;
  }>,
  exists: (contentHash: string) => Promise<boolean>,
): Promise<number> {
  let total = 0;
  for (const file of files) {
    if (file.action === "delete") continue;
    if (await exists(file.contentHash)) continue;
    // A payload that is really here is charged by its actual length, whatever the
    // chunk fields claim: `content` and `contentChunks` are mutually exclusive in the
    // push contract, and this is the half that must never be talked down by the other.
    if (file.content !== null) {
      total += BLOB_HEADER_BYTES + file.content.byteLength;
      continue;
    }
    const chunkCount = file.contentChunks ?? 0;
    if (chunkCount === 0) continue;
    total += BLOB_HEADER_BYTES + storedChunkRegionBytes(file.sizeBytes ?? 0);
  }
  return total;
}

/**
 * Compute the retention cutoff (latest timestamp to KEEP) for a version chain
 * given a retention window in days. Returns null when retention is disabled
 * (retentionDays == null). Rows older than this cutoff should be pruned.
 */
export function retentionCutoff(retentionDays: number | null, now = new Date()): Date | null {
  if (retentionDays == null) return null;
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * What the service occupies on disk: the encrypted blob bytes and how many blobs
 * there are.
 *
 * Both come from walking every vault's blob directory, which is the most
 * expensive thing the admin API reports — so it is cached for a short window.
 * The monitoring page reads it on its slow cadence (and on demand); without the
 * cache, a service holding thousands of files would walk every one of them on
 * every poll.
 *
 * The walk itself is **not** part of this module: {@link storageUsage} takes it
 * as an injected `measure`, so importing this cache never opens SQLite or touches
 * the blob store. The admin route wires in the real walk; the unit tests pass a
 * function.
 */
export interface StorageUsage {
  bytes: number;
  blobs: number;
  /** How many vaults were walked to measure it. */
  vaults: number;
  /** When this answer was measured. */
  measuredAt: Date;
}

/** One walk's answer, before the cache stamps it with `measuredAt`. */
export type StorageMeasurement = Omit<StorageUsage, "measuredAt">;

/** How long a measured answer is reused. */
export const STORAGE_USAGE_TTL_MS = 30_000;

let cached: StorageUsage | null = null;
/** A measurement in flight, so two callers cannot walk the store twice. */
let inFlight: Promise<StorageUsage> | null = null;

/**
 * Storage usage, from the cache when it is fresh. `measure` is the walk; `force`
 * measures again, which is what a test uses. The TTL is what keeps a polling page
 * from re-walking the blob store every few seconds.
 */
export async function storageUsage(options: {
  measure: () => Promise<StorageMeasurement>;
  force?: boolean;
}): Promise<StorageUsage> {
  const now = Date.now();
  if (!options.force && cached && now - cached.measuredAt.getTime() < STORAGE_USAGE_TTL_MS) {
    return cached;
  }
  if (inFlight) return inFlight;

  inFlight = options.measure().then(
    (measurement) => {
      const usage = { ...measurement, measuredAt: new Date() };
      cached = usage;
      inFlight = null;
      return usage;
    },
    (error: unknown) => {
      inFlight = null;
      throw error;
    },
  );
  return inFlight;
}

/** Forget the cached measurement (a vault was deleted, so the total changed). */
export function invalidateStorageUsage(): void {
  cached = null;
}

/**
 * Per-user usage, cached the same way and for the same reason: enforcing a
 * `storage_bytes_limit` on every push would otherwise walk every one of that
 * user's blob directories on every batch.
 *
 * The walk is the truth; a push adds what it wrote to the cached number
 * (`recordUserStorageUsage`) so a burst is accounted for without re-measuring.
 * That makes the enforcement window at most one TTL wide: a user can overshoot
 * their limit by whatever they push in the same window as the walk that let them
 * through. Deliberate — the alternative is a directory walk per push.
 */
interface UserUsage {
  bytes: number;
  measuredAt: Date;
}

const userCache = new Map<string, UserUsage>();
const userInFlight = new Map<string, Promise<number>>();

/**
 * Storage used by one user's vaults, measured by `measure` when the cache is
 * stale. `force` measures again, which is what a test uses.
 */
export async function userStorageUsage(
  userId: string,
  options: { force?: boolean; measure: (userId: string) => Promise<number> },
): Promise<number> {
  const now = Date.now();
  const hit = userCache.get(userId);
  if (!options.force && hit && now - hit.measuredAt.getTime() < STORAGE_USAGE_TTL_MS) {
    return hit.bytes;
  }
  const running = userInFlight.get(userId);
  if (running) return running;

  const pending = options.measure(userId).then(
    (bytes) => {
      userCache.set(userId, { bytes, measuredAt: new Date() });
      userInFlight.delete(userId);
      return bytes;
    },
    (error: unknown) => {
      userInFlight.delete(userId);
      throw error;
    },
  );
  userInFlight.set(userId, pending);
  return pending;
}

/**
 * Add what a push wrote to the cached usage, so the next check counts it without
 * a walk. A user with no cache entry is left alone: the next check measures.
 */
export function recordUserStorageUsage(userId: string, bytes: number): void {
  if (bytes <= 0) return;
  const hit = userCache.get(userId);
  if (!hit) return;
  userCache.set(userId, { bytes: hit.bytes + bytes, measuredAt: hit.measuredAt });
}

/** Forget a cached measurement, for one user or all of them. */
export function invalidateUserStorageUsage(userId?: string): void {
  if (userId === undefined) {
    userCache.clear();
    return;
  }
  userCache.delete(userId);
}

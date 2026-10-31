/**
 * The pass's work order: the files a person is most likely to look at first.
 *
 * A cold start has to make the same decisions either way, but the order it makes them
 * in is what a user feels. A phone opening a vault that changed on another device used
 * to work through the set of chains in whatever order the server answered, so the note
 * on screen could be the last one pulled. Two cheap signals already exist:
 *
 * - the **host** states the paths the app has open or opened most recently
 *   (`Workspace.getActiveFile` plus `getLastOpenFiles` on the Obsidian side), and
 * - the **engine** records the modification stamp of every file it has synced, so the
 *   most recently edited files can be ranked without any new persistence.
 *
 * The ranking is a **preference, never a filter**: a path that matches nothing is
 * simply ranked last, and every file is still decided. That is what keeps it safe to
 * use a list the user can change at any time (a closed note, a deleted file, a path
 * from another vault).
 */

import { sortedCopy } from "@courier/shared";

/**
 * How many paths a host may state, most important first.
 *
 * The list is a hint, so a cap costs nothing: a host that hands over the whole vault
 * would make the ranking meaningless (and sorting it a second pass over every file).
 * Obsidian's own recent list is ten entries, so this is deliberately generous.
 */
export const MAX_PRIORITY_PATHS = 64;

/**
 * Clean a host's list: strings only, no empty entries, duplicates removed, order kept.
 *
 * Order is the meaning here — the first path is the one the user is looking at — so
 * this returns an array rather than a set, and it must not sort.
 */
export function normalizePriorityPaths(paths: readonly string[] | undefined): string[] {
  // A host is external input too: a provider that hands back something other than a
  // list is a host with no preference, not a reason for the pass to fail.
  if (!Array.isArray(paths)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= MAX_PRIORITY_PATHS) break;
  }
  return out;
}

/** path → its position in a normalized list, for the rank lookups below. */
export function priorityRanks(paths: readonly string[]): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const [index, path] of paths.entries()) ranks.set(path, index);
  return ranks;
}

/** One item to order: what to keep, which paths name it, and its two tie-breakers. */
export interface PrioritizedEntry {
  /** The value returned in the ordered result (a fileId, or a path for local creates). */
  key: string;
  /**
   * The paths this item is known by, most specific first.
   *
   * A chain can be named by two paths at once: the path the server records (which moves
   * ahead of this device after a peer rename) and the path the local file actually has
   * (which changes ahead of the server after a local rename). Either one may be the
   * path the user has open, so the item takes the **best** rank of the two.
   */
  paths: ReadonlyArray<string | null | undefined>;
  /** Last modification time, when known — the "recently edited" tie-breaker. */
  mtimeMs: number;
  /**
   * Whether this item is a chain this device already tracks (has a state entry).
   *
   * A tracked chain goes before a remote-only one at the same rank: when a peer's
   * rename or delete leaves two chains naming one path for a moment, the chain whose
   * file is actually on disk has to settle that path before the remote-only chain
   * decides about it — otherwise the second one reads the first chain's file as a
   * divergence and parks a conflict copy of content that never conflicted.
   */
  locallyTracked?: boolean;
  /** The pass's original position, so equal entries keep a deterministic order. */
  position: number;
}

/** The best (lowest) rank any of `paths` has, or `Infinity` when none is listed. */
export function rankOfPaths(
  paths: ReadonlyArray<string | null | undefined>,
  ranks: ReadonlyMap<string, number>,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (const path of paths) {
    if (path === null || path === undefined) continue;
    const rank = ranks.get(path);
    if (rank !== undefined && rank < best) best = rank;
  }
  return best;
}

/**
 * Order entries by the user's list, then a tracked chain before a remote-only one,
 * then by recency, then by the pass's own order.
 *
 * `Infinity` is compared directly rather than subtracted: `Infinity - Infinity` is
 * `NaN`, and a comparator that answers `NaN` is a comparator that leaves the order to
 * the engine. A tracked chain is preferred over a remote-only one at the same rank
 * because two chains can name one path while a peer's move is in flight; the chain
 * whose file is on disk has to settle it first. Ties after that fall through to
 * `mtimeMs` (descending) so a host with no recent list still surfaces the files edited
 * last, and finally to the original position, which keeps two runs over the same
 * snapshot identical.
 */
export function orderByPriority(
  entries: readonly PrioritizedEntry[],
  ranks: ReadonlyMap<string, number>,
): string[] {
  return sortedCopy(entries, (a, b) => {
    const rankA = rankOfPaths(a.paths, ranks);
    const rankB = rankOfPaths(b.paths, ranks);
    if (rankA !== rankB) return rankA < rankB ? -1 : 1;
    const trackedA = a.locallyTracked === true;
    const trackedB = b.locallyTracked === true;
    if (trackedA !== trackedB) return trackedA ? -1 : 1;
    if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.position - b.position;
  }).map((entry) => entry.key);
}

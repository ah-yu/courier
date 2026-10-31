import { isConflictFile } from "@courier/engine";
import { isFolderCoveredByExclusion } from "./excluded-folders";

/**
 * The Courier action a vault path is offered, by kind of row.
 *
 * - `conflict` — a parked copy (`*.conflict.*`). It has no chain of its own, so the only
 *   actions are comparing it with the original and replacing the original with it;
 * - `history` — every other file, whose chain the version-history tab reads.
 */
export type FileActionKind = "conflict" | "history";

/**
 * Which Courier action a path gets, or `null` for none.
 *
 * **One rule for both surfaces** — the file explorer's chips and the file menu — because
 * they have to answer the same thing for the same file: an entry point that opens a tab for
 * a path this device is not syncing is worse than no entry point at all.
 *
 * A path under an **excluded folder** gets nothing: the folder is outside this device's
 * scope, so the answer follows the scope, not the file. The engine keeps what it already
 * had there — a chain from before the exclusion, a file moved into the folder — and a copy
 * parked before the exclusion is still on disk, but none of them is offered from here. A
 * `*.conflict.*` name under the folder is not a copy the engine would park now either,
 * because it never decides a conflict for a path it does not sync.
 */
export function fileActionFor(
  path: string,
  excludedFolders: readonly string[],
): FileActionKind | null {
  // The same predicate the engine, the settings dialog and the explorer's dimming use, so
  // "excluded" means one thing on every surface.
  if (isFolderCoveredByExclusion(path, excludedFolders)) return null;
  return isConflictFile(path) ? "conflict" : "history";
}

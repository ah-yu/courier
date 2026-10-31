/**
 * The vault paths a person is looking at, most important first.
 *
 * The pass uses this only to **order** its work: the note on screen is pulled before
 * the rest of a cold start. No new persistence is involved, because Obsidian already
 * keeps both halves of the answer:
 *
 * - `workspace.getActiveFile()` is the note the app has open now (the one a phone
 *   restores from its saved layout), and
 * - `workspace.getLastOpenFiles()` is the ten files opened most recently, persisted by
 *   Obsidian itself across restarts.
 *
 * Both are read at call time and can be empty before the layout is ready, which is
 * harmless: the engine still ranks recently edited files by their recorded stamp, and
 * an unmatched path is simply ranked last. The list is deduplicated without reordering,
 * because "the first one is the one being looked at" is the whole meaning here.
 */
export interface PriorityWorkspace {
  /** The file in the active leaf, or null when nothing (or a non-file view) is active. */
  getActiveFile(): { path: string } | null;
  /** The ten most recently opened file paths, newest first. */
  getLastOpenFiles(): string[];
}

export function priorityPathsFrom(workspace: PriorityWorkspace): string[] {
  const paths = new Set<string>();
  const active = workspace.getActiveFile()?.path;
  if (active) paths.add(active);
  for (const path of workspace.getLastOpenFiles()) {
    if (path) paths.add(path);
  }
  return [...paths];
}

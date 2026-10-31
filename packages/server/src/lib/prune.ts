// Pure pruning helpers — kept free of DB imports so they can be unit-tested.

export interface VersionRow {
  fileId: string;
  versionId: string;
  createdAt: string | Date;
}

/**
 * Decide which rows of a file's version chain to prune given a retention
 * cutoff. The latest version of every file is ALWAYS kept (it represents the
 * current file state — deleting it would lose the live path/content).
 */
export function selectRowsToPrune(rows: VersionRow[], cutoff: Date): VersionRow[] {
  if (rows.length === 0) return [];
  // Rows arrive ordered oldest → newest; the last is the latest version.
  const latest = rows[rows.length - 1];
  return rows.filter((r) => {
    if (r.versionId === latest.versionId) return false;
    return new Date(r.createdAt).getTime() < cutoff.getTime();
  });
}

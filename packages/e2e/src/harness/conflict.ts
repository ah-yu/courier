/**
 * Finding the conflict copy a resolved conflict left behind.
 *
 * A copy is named after the second it was parked at —
 * `{stem}-{YYYY-MM-DD-HHmmss}[-n].conflict{ext}` — so a test **cannot** rebuild that name
 * from its own clock: the engine reads the wall clock when it parks, and an assertion that
 * races that read fails once in a while on a slow machine (and did, at day precision, only
 * because a day is a much wider window). `conflict-file.test.ts` pins the naming rule; this
 * answers the only other question a test has — which parked copy belongs to this note — by
 * the parts of the name that do not move: the folder, the stem and the `.conflict` marker.
 */
export function conflictCopyOf(paths: Iterable<string>, plainPath: string, nth = 1): string | null {
  const slash = plainPath.lastIndexOf("/");
  const dir = slash >= 0 ? plainPath.slice(0, slash + 1) : "";
  const name = slash >= 0 ? plainPath.slice(slash + 1) : plainPath;
  const dot = name.lastIndexOf(".");
  // dot === 0 is a leading dot (a dotfile), not an extension separator.
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const pattern = new RegExp(
    `^${escapeRegExp(`${dir}${stem}`)}-\\d{4}-\\d{2}-\\d{2}-\\d{6}(?:-(\\d+))?\\.conflict`,
  );
  for (const path of paths) {
    const match = pattern.exec(path);
    if (match && Number(match[1] ?? 1) === nth) return path;
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

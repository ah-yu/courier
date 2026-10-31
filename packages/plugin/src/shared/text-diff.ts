/**
 * A line-level diff for the two surfaces that compare two versions of a text file: the
 * conflict comparison (a parked copy against the file it was parked beside) and the
 * version-history view (a version against the one before it).
 *
 * Deliberately dependency-free: the plugin bundles one `main.js`, and its runtime
 * dependencies are the workspace packages plus `obsidian`. The algorithm is a plain
 * LCS over lines with a hard **cell budget** — a file long enough to exceed it is not
 * aligned at all (`tooLarge`), because a viewer cannot usefully show a diff of tens of
 * thousands of lines anyway, and allocating the table would be what a phone notices.
 *
 * The result is one row model for both presentations: a `change` row already holds the
 * old and the new line, so the split view renders it as two columns and the unified
 * view as a `-` line followed by a `+` line.
 */

/** What one side-by-side row is: both sides agree, or one of the three difference shapes. */
export type DiffRowKind = "same" | "add" | "remove" | "change";

/**
 * One row of the comparison.
 *
 * `left` is the parked copy (this device's losing version) and `right` is the file as
 * it stands now (the version that won); the line numbers are 1-based and null on the
 * side the line does not exist.
 */
export interface DiffRow {
  kind: DiffRowKind;
  left: string | null;
  leftNo: number | null;
  right: string | null;
  rightNo: number | null;
}

/** Either the aligned rows, or the answer that this pair is too big to align. */
export type TextDiff = { rows: DiffRow[] } | { tooLarge: true };

/**
 * The largest LCS table this diff will allocate: 4M cells, 16 MB as a `Uint32Array`.
 *
 * Chosen so a few-thousand-line pair diffs instantly while a pathological one (a vault
 * file of 100k lines) is refused instead of freezing the renderer.
 */
export const MAX_DIFF_CELLS = 4_000_000;

/** One line of the unified presentation. */
export interface UnifiedLine {
  marker: " " | "-" | "+";
  text: string;
}

/**
 * Align two texts by line.
 *
 * `\r\n` and a lone `\r` are normalised to `\n` first, and a single trailing newline is
 * a line **terminator** rather than an empty last line, so a file that only gained a
 * final newline compares equal — the view is a viewer, not a byte comparison.
 */
export function diffTextLines(before: string, after: string): TextDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  if ((a.length + 1) * (b.length + 1) > MAX_DIFF_CELLS) return { tooLarge: true };

  const width = b.length + 1;
  // Suffix lengths of the longest common subsequence, walked backwards so the forward
  // pass below never needs to look ahead.
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + (j + 1)] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + (j + 1)]);
    }
  }

  type Op = { kind: "same" | "remove" | "add"; text: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + (j + 1)]) {
      ops.push({ kind: "remove", text: a[i] });
      i++;
    } else {
      ops.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < a.length) ops.push({ kind: "remove", text: a[i++] });
  while (j < b.length) ops.push({ kind: "add", text: b[j++] });

  return { rows: rowsFrom(ops) };
}

/** The unified presentation of an aligned pair: one entry per printed line. */
export function unifiedLines(rows: DiffRow[]): UnifiedLine[] {
  const lines: UnifiedLine[] = [];
  for (const row of rows) {
    switch (row.kind) {
      case "same":
        lines.push({ marker: " ", text: row.right ?? "" });
        break;
      case "remove":
        lines.push({ marker: "-", text: row.left ?? "" });
        break;
      case "add":
        lines.push({ marker: "+", text: row.right ?? "" });
        break;
      case "change":
        lines.push({ marker: "-", text: row.left ?? "" });
        lines.push({ marker: "+", text: row.right ?? "" });
        break;
    }
  }
  return lines;
}

/** Lines of a text, with the platform's line endings normalised and no phantom tail. */
function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Pair each maximal run of removals and additions into `change` rows.
 *
 * Pairing by position is what makes the split view readable: a block of five removed
 * lines followed by five added ones shows as five changed rows, not as a stack of
 * deletions above a stack of insertions.
 */
function rowsFrom(ops: Array<{ kind: "same" | "remove" | "add"; text: string }>): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  let index = 0;

  while (index < ops.length) {
    const op = ops[index];
    if (op.kind === "same") {
      rows.push({ kind: "same", left: op.text, leftNo: oldNo++, right: op.text, rightNo: newNo++ });
      index++;
      continue;
    }

    const removed: string[] = [];
    const added: string[] = [];
    while (index < ops.length && ops[index].kind !== "same") {
      const differing = ops[index++];
      if (differing.kind === "remove") removed.push(differing.text);
      else added.push(differing.text);
    }

    const paired = Math.min(removed.length, added.length);
    for (let p = 0; p < paired; p++) {
      rows.push({
        kind: "change",
        left: removed[p],
        leftNo: oldNo++,
        right: added[p],
        rightNo: newNo++,
      });
    }
    for (let p = paired; p < removed.length; p++) {
      rows.push({ kind: "remove", left: removed[p], leftNo: oldNo++, right: null, rightNo: null });
    }
    for (let p = paired; p < added.length; p++) {
      rows.push({ kind: "add", left: null, leftNo: null, right: added[p], rightNo: newNo++ });
    }
  }

  return rows;
}

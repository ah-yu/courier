import { describe, expect, it } from "vitest";
import { diffTextLines, unifiedLines, type DiffRow } from "./text-diff";

/** The unaligned shape, so a row assertion reads as the thing a person sees. */
function shape(diff: ReturnType<typeof diffTextLines>): Array<[DiffRow["kind"], string, string]> {
  if ("tooLarge" in diff) throw new Error("expected rows");
  return diff.rows.map((row) => [row.kind, row.left ?? "", row.right ?? ""]);
}

const lines = (count: number, tag: string) =>
  Array.from({ length: count }, (_, index) => `${tag} ${index}`).join("\n");

describe("diffTextLines", () => {
  it("marks an unchanged file as all-same, with matching line numbers", () => {
    const diff = diffTextLines("a\nb\n", "a\nb\n");
    if ("tooLarge" in diff) throw new Error("expected rows");
    expect(diff.rows).toEqual([
      { kind: "same", left: "a", leftNo: 1, right: "a", rightNo: 1 },
      { kind: "same", left: "b", leftNo: 2, right: "b", rightNo: 2 },
    ]);
  });

  it("reads an insertion and a deletion as their own rows", () => {
    expect(shape(diffTextLines("a\nc\n", "a\nb\nc\n"))).toEqual([
      ["same", "a", "a"],
      ["add", "", "b"],
      ["same", "c", "c"],
    ]);
    expect(shape(diffTextLines("a\nb\nc\n", "a\nc\n"))).toEqual([
      ["same", "a", "a"],
      ["remove", "b", ""],
      ["same", "c", "c"],
    ]);
  });

  it("pairs a replaced block by position instead of stacking - above +", () => {
    expect(shape(diffTextLines("a\nb\nc\n", "a\nB\nC\n"))).toEqual([
      ["same", "a", "a"],
      ["change", "b", "B"],
      ["change", "c", "C"],
    ]);
  });

  it("keeps the leftover rows when a block changes size", () => {
    expect(shape(diffTextLines("one\ntwo\n", "ONE\n"))).toEqual([
      ["change", "one", "ONE"],
      ["remove", "two", ""],
    ]);
    expect(shape(diffTextLines("one\n", "ONE\nTWO\n"))).toEqual([
      ["change", "one", "ONE"],
      ["add", "", "TWO"],
    ]);
  });

  it("treats an empty side as all-added or all-removed", () => {
    expect(shape(diffTextLines("", "x\n"))).toEqual([["add", "", "x"]]);
    expect(shape(diffTextLines("x\n", ""))).toEqual([["remove", "x", ""]]);
    expect(shape(diffTextLines("", ""))).toEqual([]);
  });

  it("normalises CRLF and one trailing newline, because it is a viewer", () => {
    expect(shape(diffTextLines("a\r\nb", "a\nb\n"))).toEqual([
      ["same", "a", "a"],
      ["same", "b", "b"],
    ]);
    // A trailing blank line in the middle of the text is a real line, unlike the final one.
    expect(shape(diffTextLines("a\n\nb", "a\nb"))).toEqual([
      ["same", "a", "a"],
      ["remove", "", ""],
      ["same", "b", "b"],
    ]);
  });

  it("refuses a pair too large to align instead of allocating the table", () => {
    expect(diffTextLines(lines(3000, "a"), lines(3000, "b"))).toEqual({ tooLarge: true });
    // Just under the budget still aligns.
    expect("rows" in diffTextLines(lines(100, "a"), lines(100, "b"))).toBe(true);
  });
});

describe("unifiedLines", () => {
  it("prints a change as a removed line followed by an added one", () => {
    const diff = diffTextLines("a\nb", "a\nB");
    if ("tooLarge" in diff) throw new Error("expected rows");
    expect(unifiedLines(diff.rows)).toEqual([
      { marker: " ", text: "a" },
      { marker: "-", text: "b" },
      { marker: "+", text: "B" },
    ]);
  });
});

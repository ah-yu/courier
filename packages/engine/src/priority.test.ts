import { describe, expect, it } from "vitest";
import {
  MAX_PRIORITY_PATHS,
  normalizePriorityPaths,
  orderByPriority,
  priorityRanks,
  rankOfPaths,
  type PrioritizedEntry,
} from "./priority";

describe("normalizePriorityPaths", () => {
  it("keeps the stated order — the first path is the one being looked at", () => {
    expect(normalizePriorityPaths(["b.md", "a.md", "c.md"])).toEqual(["b.md", "a.md", "c.md"]);
  });

  it("drops empty entries and duplicates without reordering the rest", () => {
    expect(normalizePriorityPaths(["", "a.md", "a.md", "b.md", ""])).toEqual(["a.md", "b.md"]);
  });

  it("answers an empty list for no input, a non-array, or entries that are not strings", () => {
    expect(normalizePriorityPaths(undefined)).toEqual([]);
    expect(normalizePriorityPaths([])).toEqual([]);
    expect(normalizePriorityPaths("not-a-list" as unknown as string[])).toEqual([]);
    expect(
      normalizePriorityPaths([null as unknown as string, 3 as unknown as string, "a.md"]),
    ).toEqual(["a.md"]);
  });

  it("caps the list so a host that hands over the vault cannot make the ranking meaningless", () => {
    const all = Array.from({ length: MAX_PRIORITY_PATHS + 10 }, (_, index) => `n-${index}.md`);
    const normalized = normalizePriorityPaths(all);

    expect(normalized).toHaveLength(MAX_PRIORITY_PATHS);
    expect(normalized[0]).toBe("n-0.md");
    expect(normalized.at(-1)).toBe(`n-${MAX_PRIORITY_PATHS - 1}.md`);
  });
});

describe("priorityRanks / rankOfPaths", () => {
  it("ranks by position and answers Infinity for a path nobody listed", () => {
    const ranks = priorityRanks(["b.md", "a.md"]);

    expect(ranks.get("b.md")).toBe(0);
    expect(ranks.get("a.md")).toBe(1);
    expect(rankOfPaths(["nope.md"], ranks)).toBe(Number.POSITIVE_INFINITY);
    expect(rankOfPaths([null, undefined], ranks)).toBe(Number.POSITIVE_INFINITY);
  });

  it("takes the best rank when an item is known by two paths", () => {
    // A peer renamed the note, so the chain's recorded path is new while the local file
    // is still at the old one — the old path is the one the user has open.
    const ranks = priorityRanks(["old.md", "new.md"]);
    expect(rankOfPaths(["new.md", "old.md"], ranks)).toBe(0);
  });
});

function entry(
  key: string,
  paths: Array<string | null | undefined>,
  mtimeMs = 0,
  position = 0,
): PrioritizedEntry {
  return { key, paths, mtimeMs, position };
}

describe("orderByPriority", () => {
  it("puts the user's paths first, in the order the host stated them", () => {
    const ranks = priorityRanks(["b.md", "a.md"]);
    const ordered = orderByPriority(
      [
        entry("c", ["c.md"], 3_000, 0),
        entry("a", ["a.md"], 1_000, 1),
        entry("b", ["b.md"], 2_000, 2),
      ],
      ranks,
    );

    expect(ordered).toEqual(["b", "a", "c"]);
  });

  it("orders the files nobody listed by modification time, newest first", () => {
    const ordered = orderByPriority(
      [
        entry("old", ["old.md"], 1_000, 0),
        entry("new", ["new.md"], 9_000, 1),
        entry("mid", ["mid.md"], 5_000, 2),
      ],
      priorityRanks([]),
    );

    expect(ordered).toEqual(["new", "mid", "old"]);
  });

  it("keeps the pass's own order when neither rank nor time distinguishes two files", () => {
    const ordered = orderByPriority(
      [entry("first", ["same.md"], 0, 0), entry("second", ["same.md"], 0, 1)],
      priorityRanks([]),
    );

    expect(ordered).toEqual(["first", "second"]);
  });

  it("treats two unlisted files as equal ranks rather than as NaN", () => {
    // `Infinity - Infinity` is NaN; a comparator that answers NaN leaves the order to
    // the engine. The mtime tie-break is what proves the ranks compared equal.
    const ordered = orderByPriority(
      [entry("slow", ["x.md"], 1, 0), entry("fast", ["y.md"], 2, 1)],
      priorityRanks(["other.md"]),
    );

    expect(ordered).toEqual(["fast", "slow"]);
  });

  it("puts a tracked chain before a remote-only one at the same rank and time", () => {
    // A peer's move can leave two chains naming one path for a moment. The chain whose
    // file is on disk has to settle it first; the remote-only one must not read that
    // file as a divergence.
    const ordered = orderByPriority(
      [
        entry("remote", ["same.md"], 5_000, 0),
        { ...entry("tracked", ["same.md"], 5_000, 1), locallyTracked: true },
      ],
      priorityRanks([]),
    );

    expect(ordered).toEqual(["tracked", "remote"]);
  });

  it("still puts a path the user named before the tracked tie-break", () => {
    const ordered = orderByPriority(
      [
        { ...entry("tracked", ["local.md"], 9_000, 0), locallyTracked: true },
        entry("open", ["open.md"], 1_000, 1),
      ],
      priorityRanks(["open.md"]),
    );

    expect(ordered).toEqual(["open", "tracked"]);
  });

  it("does not mutate the input", () => {
    const entries = [entry("a", ["a.md"], 1, 0), entry("b", ["b.md"], 2, 1)];
    const copy = [...entries];

    orderByPriority(entries, priorityRanks(["b.md"]));

    expect(entries).toEqual(copy);
  });
});

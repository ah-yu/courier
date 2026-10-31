import { describe, expect, it } from "vitest";
import { reversedCopy, sortedCopy } from "./collections";

describe("sortedCopy", () => {
  it("sorts a copy and leaves the input alone", () => {
    const input = ["b", "c", "a"];
    expect(sortedCopy(input)).toEqual(["a", "b", "c"]);
    expect(input).toEqual(["b", "c", "a"]);
  });

  it("takes a comparator, and a non-array iterable", () => {
    expect(sortedCopy(new Set([3, 1, 2]), (a, b) => a - b)).toEqual([1, 2, 3]);
    expect(sortedCopy(["bb", "a", "ccc"], (a, b) => a.length - b.length)).toEqual([
      "a",
      "bb",
      "ccc",
    ]);
  });
});

describe("reversedCopy", () => {
  it("reverses a copy and leaves the input alone", () => {
    const input = [1, 2, 3];
    expect(reversedCopy(input)).toEqual([3, 2, 1]);
    expect(input).toEqual([1, 2, 3]);
  });
});

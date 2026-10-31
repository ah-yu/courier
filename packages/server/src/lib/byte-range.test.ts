import { describe, expect, it } from "vitest";
import { parseByteRange } from "./byte-range";

/**
 * `Range` resolution for the version-content route.
 *
 * The forms below are the ones a client (and a proxy) actually sends; the rest of
 * the header space is deliberately ignored (serve the whole body) rather than
 * answered, because a multipart response is a parser nothing needs.
 */
describe("parseByteRange", () => {
  it("serves the whole body when there is no range", () => {
    expect(parseByteRange(null, 100)).toBeNull();
    expect(parseByteRange(undefined, 100)).toBeNull();
  });

  it("resolves a closed range", () => {
    expect(parseByteRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange("bytes=90-99", 100)).toEqual({ start: 90, end: 99 });
  });

  it("clamps an end past the blob and keeps an open-ended range to the last byte", () => {
    expect(parseByteRange("bytes=90-1000", 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
  });

  it("resolves a suffix range against the end", () => {
    expect(parseByteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange("bytes=-1000", 100)).toEqual({ start: 0, end: 99 });
  });

  it("accepts a single-byte range", () => {
    expect(parseByteRange("bytes=5-5", 100)).toEqual({ start: 5, end: 5 });
  });

  it("answers a range it cannot satisfy as invalid", () => {
    expect(parseByteRange("bytes=100-", 100)).toBe("invalid");
    expect(parseByteRange("bytes=200-300", 100)).toBe("invalid");
    expect(parseByteRange("bytes=9-2", 100)).toBe("invalid");
    expect(parseByteRange("bytes=-0", 100)).toBe("invalid");
    expect(parseByteRange("bytes=0-", 0)).toBe("invalid");
  });

  it("ignores a malformed header, another unit and multiple ranges", () => {
    expect(parseByteRange("items=0-9", 100)).toBeNull();
    expect(parseByteRange("bytes=abc", 100)).toBeNull();
    expect(parseByteRange("bytes=0-9,20-29", 100)).toBeNull();
    expect(parseByteRange("bytes=-", 100)).toBeNull();
    // Trailing bytes make the range unparseable; a prefix match would serve 0-9.
    expect(parseByteRange("bytes=0-9x", 100)).toBeNull();
  });

  it("handles ranges beyond Number.MAX_SAFE_INTEGER as written", () => {
    const beyond = "9007199254740992"; // 2^53
    // A start past the end is unsatisfiable, not "ignore the header".
    expect(parseByteRange(`bytes=${beyond}-`, 100)).toBe("invalid");
    // An end is clamped to the last byte.
    expect(parseByteRange(`bytes=0-${beyond}`, 100)).toEqual({ start: 0, end: 99 });
    // A suffix longer than the representation selects all of it.
    expect(parseByteRange(`bytes=-${beyond}`, 100)).toEqual({ start: 0, end: 99 });
  });

  it("resolves the last-byte boundary and an empty blob", () => {
    expect(parseByteRange("bytes=99-99", 100)).toEqual({ start: 99, end: 99 });
    expect(parseByteRange("bytes=99-100", 100)).toEqual({ start: 99, end: 99 });
    expect(parseByteRange("bytes=0-", 0)).toBe("invalid");
    expect(parseByteRange("bytes=-1", 0)).toBe("invalid");
  });

  it("tolerates surrounding whitespace and a different case", () => {
    expect(parseByteRange("  bytes=0-0  ", 100)).toEqual({ start: 0, end: 0 });
    expect(parseByteRange("BYTES=0-0", 100)).toEqual({ start: 0, end: 0 });
  });
});

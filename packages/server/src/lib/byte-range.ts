/**
 * One resolved byte range of a blob. `end` is **inclusive**, matching both HTTP's
 * `Content-Range` and the `end` that `Bun.file().slice(start, end)` takes.
 */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Resolve a `Range: bytes=…` header against a blob's size.
 *
 * - `null` — serve the whole body: no header, another unit, or a malformed header
 *   (HTTP lets a server ignore a range it cannot parse), and any multi-range request
 *   (the sync client asks for one chunk at a time; a multipart answer would need a
 *   parser for a shape nothing sends).
 * - `"invalid"` — the range cannot be satisfied, so the route answers `416` with
 *   `Content-Range: bytes *\/<size>`.
 *
 * Only the three forms a client actually sends are accepted: `start-end`, `start-`
 * and the suffix form `-length`. An end past the blob is clamped, as RFC 9110
 * requires; a start at or past the end is unsatisfiable. The comparison is done in
 * `BigInt` so a value beyond `Number.MAX_SAFE_INTEGER` still means what it says: a
 * huge start is past the end (416) and a huge end is clamped, instead of the whole
 * range being silently ignored.
 */
export function parseByteRange(
  header: string | null | undefined,
  size: number,
): ByteRange | "invalid" | null {
  if (header === null || header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (match === null) return null;
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") return null;
  if (size === 0) return "invalid";
  const sizeBig = BigInt(size);

  if (startText === "") {
    const suffix = BigInt(endText);
    // A zero-length suffix selects no byte at all, which RFC 9110 calls unsatisfiable.
    if (suffix <= 0n) return "invalid";
    // A suffix longer than the representation selects all of it.
    return suffix >= sizeBig
      ? { start: 0, end: size - 1 }
      : { start: size - Number(suffix), end: size - 1 };
  }

  const start = BigInt(startText);
  if (start >= sizeBig) return "invalid";
  if (endText === "") return { start: Number(start), end: size - 1 };
  const end = BigInt(endText);
  if (end < start) return "invalid";
  return {
    start: Number(start),
    end: end >= sizeBig ? size - 1 : Number(end),
  };
}

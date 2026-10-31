import { describe, expect, it } from "vitest";
import {
  CHUNKED_TRANSFER_THRESHOLD,
  chunkBounds,
  chunkCountForSize,
  shouldTransferInChunks,
} from "./chunked-transfer";

describe("chunked transfer geometry", () => {
  it("chunks files above the threshold, and only those", () => {
    expect(shouldTransferInChunks(CHUNKED_TRANSFER_THRESHOLD)).toBe(false);
    expect(shouldTransferInChunks(CHUNKED_TRANSFER_THRESHOLD + 1)).toBe(true);
    expect(shouldTransferInChunks(1024)).toBe(false);
  });

  it("counts chunks, including a short last one", () => {
    const size = 9 * 1024 * 1024;
    expect(chunkCountForSize(size)).toBe(3);
    expect(chunkBounds(0, size)).toEqual({ start: 0, end: 4 * 1024 * 1024 });
    expect(chunkBounds(1, size)).toEqual({ start: 4 * 1024 * 1024, end: 8 * 1024 * 1024 });
    expect(chunkBounds(2, size)).toEqual({ start: 8 * 1024 * 1024, end: size });
  });
});

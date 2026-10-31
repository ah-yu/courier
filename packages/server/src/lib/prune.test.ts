import { describe, expect, it } from "vitest";
import { selectRowsToPrune } from "./prune";

function row(fileId: string, versionId: string, iso: string) {
  return { fileId, versionId, createdAt: iso };
}

describe("selectRowsToPrune", () => {
  const cutoff = new Date("2026-06-01T00:00:00.000Z");

  it("keeps the latest version of every file regardless of age", () => {
    const rows = [
      row("f1", "v1", "2026-01-01T00:00:00.000Z"),
      row("f1", "v2", "2026-07-01T00:00:00.000Z"),
    ];
    expect(selectRowsToPrune(rows, cutoff).map((r) => r.versionId)).toEqual(["v1"]);
  });

  it("keeps rows newer than the cutoff", () => {
    const rows = [
      row("f1", "v1", "2026-05-15T00:00:00.000Z"), // older than cutoff
      row("f1", "v2", "2026-05-20T00:00:00.000Z"), // older than cutoff
      row("f1", "v3", "2026-07-01T00:00:00.000Z"), // latest, kept
    ];
    expect(selectRowsToPrune(rows, cutoff).map((r) => r.versionId)).toEqual(["v1", "v2"]);
  });

  it("handles empty chains", () => {
    expect(selectRowsToPrune([], cutoff)).toEqual([]);
  });
});

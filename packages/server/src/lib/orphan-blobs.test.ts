import { describe, expect, it, vi } from "vitest";
import { sweepOrphanBlobs, type OrphanBlobSweepDeps } from "./orphan-blobs";

const NOW = 10_000;
const TTL = 1_000;

/** A blob as the fake store holds it: content hash and file mtime. */
interface FakeBlob {
  mtimeMs: number;
}

function depsFor(
  blobs: Record<string, Record<string, FakeBlob>>,
  referenced: Record<string, string[]>,
): OrphanBlobSweepDeps & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    listVaultIds: vi.fn(async () => Object.keys(blobs)),
    listBlobHashes: vi.fn(async (vaultId: string) => Object.keys(blobs[vaultId] ?? {})),
    listReferencedHashes: vi.fn(async (vaultId: string) => referenced[vaultId] ?? []),
    statBlob: vi.fn(async (vaultId: string, hash: string) =>
      blobs[vaultId]?.[hash] === undefined
        ? undefined
        : ({
            size: 0,
            dataOffset: 24,
            dataStart: 24,
            filePath: "/dev/null",
            header: { flags: 0, chunkSize: 0, chunkCount: 1, plaintextSize: 0 },
            mtimeMs: blobs[vaultId]![hash]!.mtimeMs,
          } as const),
    ),
    deleteBlob: vi.fn(async (vaultId: string, hash: string) => {
      deleted.push(`${vaultId}/${hash}`);
      delete blobs[vaultId]![hash];
    }),
  };
}

describe("sweepOrphanBlobs", () => {
  it("deletes an old unreferenced blob and keeps referenced or young ones", async () => {
    const blobs = {
      v1: {
        "old-orphan": { mtimeMs: NOW - TTL - 1 },
        "old-live": { mtimeMs: NOW - TTL - 1 },
        "young-orphan": { mtimeMs: NOW - TTL + 1 },
      },
    };
    const deps = depsFor(blobs, { v1: ["old-live"] });

    expect(await sweepOrphanBlobs(deps, { now: NOW, minAgeMs: TTL })).toBe(1);
    expect(deps.deleted).toEqual(["v1/old-orphan"]);
    // The young blob is still in flight: a push may be between its write and its row.
    expect(blobs.v1["young-orphan"]).toBeDefined();
    expect(blobs.v1["old-live"]).toBeDefined();
  });

  it("skips a vault whose referenced-hash read failed, rather than deleting live content", async () => {
    const blobs = { v1: { "old-blob": { mtimeMs: NOW - TTL - 1 } } };
    const deps = depsFor(blobs, { v1: ["old-blob"] });
    deps.listReferencedHashes = vi.fn(async () => {
      throw new Error("database unavailable");
    });

    expect(await sweepOrphanBlobs(deps, { now: NOW, minAgeMs: TTL })).toBe(0);
    expect(blobs.v1["old-blob"]).toBeDefined();
  });

  it("keeps a blob exactly at the age cutoff", async () => {
    const blobs = { v1: { boundary: { mtimeMs: NOW - TTL } } };
    const deps = depsFor(blobs, { v1: [] });

    // "Older than the TTL" is strict: exactly TTL old may still be in flight.
    expect(await sweepOrphanBlobs(deps, { now: NOW, minAgeMs: TTL })).toBe(0);
    expect(blobs.v1.boundary).toBeDefined();
  });

  it("does not delete a listed hash whose blob cannot be read", async () => {
    const blobs = { v1: { "gone-file": { mtimeMs: NOW - TTL - 1 } } };
    const deps = depsFor(blobs, { v1: [] });
    deps.statBlob = vi.fn(async () => undefined);

    expect(await sweepOrphanBlobs(deps, { now: NOW, minAgeMs: TTL })).toBe(0);
    expect(deps.deleted).toEqual([]);
  });

  it("skips the whole sweep when the vault list cannot be read", async () => {
    const blobs = { v1: { old: { mtimeMs: NOW - TTL - 1 } } };
    const deps = depsFor(blobs, { v1: [] });
    deps.listVaultIds = vi.fn(async () => {
      throw new Error("database unavailable");
    });

    expect(await sweepOrphanBlobs(deps, { now: NOW, minAgeMs: TTL })).toBe(0);
    expect(blobs.v1.old).toBeDefined();
  });

  it("keeps sweeping after one delete fails", async () => {
    const blobs = {
      v1: {
        fails: { mtimeMs: NOW - TTL - 1 },
        succeeds: { mtimeMs: NOW - TTL - 1 },
      },
    };
    const deps = depsFor(blobs, { v1: [] });
    const remove = deps.deleteBlob;
    deps.deleteBlob = vi.fn(async (vaultId: string, hash: string) => {
      if (hash === "fails") throw new Error("EBUSY");
      await remove(vaultId, hash);
    });

    expect(await sweepOrphanBlobs(deps, { now: NOW, minAgeMs: TTL })).toBe(1);
    expect(blobs.v1["fails"]).toBeDefined();
    expect(blobs.v1["succeeds"]).toBeUndefined();
  });
});

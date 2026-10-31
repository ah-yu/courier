import type { DataAdapter } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { AdapterLeaseStore } from "./lease";

/**
 * The lease store inside an Obsidian vault.
 *
 * `mkdir` is the atomic primitive the "one writer per vault" rule rests on, and the
 * engine's `SyncLease` decides everything from the answers this adapter gives: a
 * throwing `mkdir` must read as "somebody else has it", a throwing `rename` as "the
 * release did not happen", a throwing `stat` as "no heartbeat". Returning `undefined`
 * or letting the error escape would turn a refusal into a crash — or worse, into a
 * second writer.
 *
 * These paths only run when an adapter misbehaves or two writers collide in the same
 * millisecond, which is exactly when the real vault gives no second chance to observe
 * them.
 */

/** A `DataAdapter` whose every call succeeds, overridable per case. */
function fakeAdapter(overrides: Partial<DataAdapter> = {}): DataAdapter {
  return {
    exists: vi.fn(async () => false),
    mkdir: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    read: vi.fn(async () => "{}"),
    write: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    rmdir: vi.fn(async () => undefined),
    stat: vi.fn(async () => null),
    ...overrides,
  } as unknown as DataAdapter;
}

function errorWithCode(code: string): Error {
  return Object.assign(new Error(`${code}: refused`), { code });
}

describe("AdapterLeaseStore", () => {
  // Every way `mkdir` can fail means "somebody else has it" to the engine: losing the
  // race (`EEXIST`) and an adapter that cannot create the folder at all (`EACCES`) must
  // both read as taken. Narrowing the catch to `EEXIST` would let the second one crash
  // the host — or, worse, be treated as success by a caller.
  it.each(["EEXIST", "EACCES"])(
    "reads a create that failed with %s as taken, not as an error",
    async (code) => {
      const adapter = fakeAdapter({
        exists: vi.fn(async () => false),
        mkdir: vi.fn(async () => {
          throw errorWithCode(code);
        }),
      });
      await expect(
        new AdapterLeaseStore(adapter).tryCreateDir(".courier/sync-lease"),
      ).resolves.toBe(false);
    },
  );

  it("does not even try to create a folder that is already there", async () => {
    const mkdir = vi.fn(async () => undefined);
    const adapter = fakeAdapter({ exists: vi.fn(async () => true), mkdir });

    await expect(new AdapterLeaseStore(adapter).tryCreateDir(".courier/sync-lease")).resolves.toBe(
      false,
    );
    expect(mkdir).not.toHaveBeenCalled();
  });

  it("creates the lease folder when it is free, and says so", async () => {
    const mkdir = vi.fn(async () => undefined);
    const adapter = fakeAdapter({ exists: vi.fn(async () => false), mkdir });

    await expect(new AdapterLeaseStore(adapter).tryCreateDir(".courier/sync-lease")).resolves.toBe(
      true,
    );
    expect(mkdir).toHaveBeenCalledWith(".courier/sync-lease");
  });

  it("swallows an already-there failure in ensureDir, which is not the lock", async () => {
    // `ensureDir` only prepares the parent; the atomic test is `tryCreateDir`. A failure
    // here must not escape, or no host could ever reach that test.
    const adapter = fakeAdapter({
      mkdir: vi.fn(async () => {
        throw errorWithCode("EEXIST");
      }),
    });
    await expect(new AdapterLeaseStore(adapter).ensureDir(".courier")).resolves.toBeUndefined();
  });

  it("reports a lost rename instead of throwing", async () => {
    // A release renames `sync-lease` aside; if a takeover got there first the rename
    // fails, and the engine needs `false` to know it no longer owns the vault.
    const adapter = fakeAdapter({
      rename: vi.fn(async () => {
        throw errorWithCode("ENOENT");
      }),
    });
    await expect(
      new AdapterLeaseStore(adapter).tryRename(
        ".courier/sync-lease",
        ".courier/sync-lease.released",
      ),
    ).resolves.toBe(false);
  });

  it("answers null for a lease file it cannot read or stat", async () => {
    const store = new AdapterLeaseStore(
      fakeAdapter({
        read: vi.fn(async () => {
          throw errorWithCode("ENOENT");
        }),
        stat: vi.fn(async () => {
          throw errorWithCode("EACCES");
        }),
      }),
    );
    await expect(store.readFile(".courier/sync-lease/owner.json")).resolves.toBeNull();
    await expect(store.stat(".courier/sync-lease/owner.json")).resolves.toBeNull();
  });

  it("reports a missing stat result as null rather than inventing a timestamp", async () => {
    const store = new AdapterLeaseStore(fakeAdapter({ stat: vi.fn(async () => null) }));
    await expect(store.stat(".courier/sync-lease/owner.json")).resolves.toBeNull();
  });

  it("maps the adapter's stat onto milliseconds", async () => {
    const store = new AdapterLeaseStore(
      fakeAdapter({
        stat: vi.fn(async () => ({
          mtime: 1_700_000_000_000,
          ctime: 0,
          size: 1,
          type: "file" as const,
        })),
      }),
    );
    await expect(store.stat(".courier/sync-lease/owner.json")).resolves.toEqual({
      mtimeMs: 1_700_000_000_000,
    });
  });

  it("removes what is there and tolerates what is not", async () => {
    const store = new AdapterLeaseStore(
      fakeAdapter({
        remove: vi.fn(async () => {
          throw errorWithCode("ENOENT");
        }),
        rmdir: vi.fn(async () => {
          throw errorWithCode("ENOENT");
        }),
      }),
    );
    await expect(store.removeFile(".courier/sync-lease/owner.json")).resolves.toBeUndefined();
    await expect(store.removeDir(".courier/sync-lease")).resolves.toBeUndefined();
  });

  it("writes the owner record through the adapter's own write", async () => {
    const write = vi.fn(async () => undefined);
    const store = new AdapterLeaseStore(fakeAdapter({ write }));

    await store.writeFile(".courier/sync-lease/owner.json", '{"owner":"plugin"}');
    expect(write).toHaveBeenCalledWith(".courier/sync-lease/owner.json", '{"owner":"plugin"}');
  });
});

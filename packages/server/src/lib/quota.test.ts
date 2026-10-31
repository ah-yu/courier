import { describe, expect, it } from "vitest";
import {
  isUserExpired,
  assertUserActive,
  assertWithinQuota,
  incomingBytes,
  retentionCutoff,
} from "./quota";
import { KeyExpiredError, QuotaExceededError } from "./errors";
import type { UserRow } from "../handlers/users-handlers";

function user(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "u-1",
    name: "A",
    key: "ck_x",
    storageBytesLimit: null,
    retentionDays: null,
    maxFileBytes: 50 * 1024 * 1024,
    maxVaults: 1,
    expiresAt: null,
    disabled: false,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("isUserExpired / assertUserActive", () => {
  const now = new Date("2026-06-10T00:00:00.000Z");

  it("treats null expiry as never expired", () => {
    expect(isUserExpired(user(), now)).toBe(false);
  });

  it("flags expired keys", () => {
    expect(isUserExpired(user({ expiresAt: "2026-06-01T00:00:00.000Z" }), now)).toBe(true);
  });

  it("treats an unparseable expiry as expired", () => {
    // `NaN <= now` is false, which used to read as "never expires" — the opposite of
    // what the same broken timestamp means for a host key. A credential nobody can
    // date is not a valid one.
    expect(isUserExpired(user({ expiresAt: "not a date" }), now)).toBe(true);
  });

  it("throws KeyExpiredError for expired users", () => {
    expect(() => assertUserActive(user({ expiresAt: "2026-06-01T00:00:00.000Z" }), now)).toThrow(
      KeyExpiredError,
    );
  });

  it("lets an active user through", () => {
    expect(() => assertUserActive(user(), now)).not.toThrow();
  });
});

describe("assertWithinQuota", () => {
  it("allows unlimited when no limit is set", () => {
    expect(() => assertWithinQuota(user(), 1e12, 1e12)).not.toThrow();
  });

  it("allows writes within the limit", () => {
    expect(() => assertWithinQuota(user({ storageBytesLimit: 1000 }), 600, 400)).not.toThrow();
  });

  it("throws QuotaExceededError past the limit", () => {
    expect(() => assertWithinQuota(user({ storageBytesLimit: 1000 }), 600, 401)).toThrow(
      QuotaExceededError,
    );
  });
});

/** One pushed file, as the quota check sees it. */
function pushedFile(
  overrides: Partial<{
    action: string;
    contentHash: string;
    content: Uint8Array | null;
    contentChunks: number;
    sizeBytes: number;
  }> = {},
) {
  return {
    action: "create",
    contentHash: "hash-1",
    content: new Uint8Array([1, 2, 3, 4]),
    ...overrides,
  };
}

const nothingStored = async () => false;
const everythingStored = async () => true;

describe("incomingBytes", () => {
  it("counts the payloads a push would add, plus the v2 header", async () => {
    await expect(
      incomingBytes([pushedFile(), pushedFile({ contentHash: "hash-2" })], nothingStored),
    ).resolves.toBe(2 * (4 + 24));
  });

  it("charges nothing for a deletion", async () => {
    await expect(
      incomingBytes([pushedFile({ action: "delete", content: null })], nothingStored),
    ).resolves.toBe(0);
    // Even if a malformed frame carried bytes on a delete, the handler writes none.
    await expect(
      incomingBytes(
        [pushedFile({ action: "delete", content: new Uint8Array(1024) })],
        nothingStored,
      ),
    ).resolves.toBe(0);
  });

  it("charges nothing for content the store already holds", async () => {
    // Blobs are addressed by hash, so re-pushing the same bytes overwrites the
    // same file: charging for it would refuse a peer that only moved a note.
    await expect(incomingBytes([pushedFile()], everythingStored)).resolves.toBe(0);
  });

  it("charges nothing for a version that carries no content", async () => {
    // A `rename` that reuses bytes the store already holds transfers no payload,
    // so it cannot cost the user any of their quota.
    await expect(
      incomingBytes([pushedFile({ action: "rename", content: null })], nothingStored),
    ).resolves.toBe(0);
  });

  it("counts the bytes as they arrived, not a reported size", async () => {
    const content = new Uint8Array(1024 * 1024);
    await expect(incomingBytes([pushedFile({ content })], nothingStored)).resolves.toBe(
      content.byteLength + 24,
    );
  });

  it("counts a chunked upload by its declared size and chunk count", async () => {
    // The bytes are not in the push: the staged chunks and the header are what the
    // store would write, so that is what the quota is charged.
    await expect(
      incomingBytes(
        [pushedFile({ content: null, contentChunks: 3, sizeBytes: 9 * 1024 * 1024 })],
        nothingStored,
      ),
    ).resolves.toBe(24 + 9 * 1024 * 1024 + 3 * 28);
  });

  it("charges a payload by its real length even if chunks are also declared", async () => {
    // The push contract makes the two mutually exclusive; this is the accounting half
    // that must not be talked down if a malformed push ever reaches it.
    const content = new Uint8Array(1024);
    await expect(
      incomingBytes([pushedFile({ content, contentChunks: 1, sizeBytes: 0 })], nothingStored),
    ).resolves.toBe(24 + content.byteLength);
  });
});

describe("retentionCutoff", () => {
  const now = new Date("2026-06-10T00:00:00.000Z");

  it("returns null when retention is disabled", () => {
    expect(retentionCutoff(null, now)).toBeNull();
  });

  it("computes the cutoff date", () => {
    expect(retentionCutoff(10, now)?.toISOString()).toBe("2026-05-31T00:00:00.000Z");
  });
});

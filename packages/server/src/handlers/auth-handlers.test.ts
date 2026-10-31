import { describe, expect, it, vi } from "vitest";
import { createApiKey, listApiKeys, revokeApiKey } from "./auth-handlers";
import type { InsertApiKeyFn, ListApiKeysFn, DeleteApiKeyFn } from "./auth-handlers";

describe("createApiKey", () => {
  it("returns name, key, scopes and expiry when created successfully", async () => {
    const dbCreatedAt = new Date("2026-06-14T12:00:00.000Z");
    const insertFn = vi.fn<InsertApiKeyFn>().mockResolvedValue({ createdAt: dbCreatedAt });

    const result = await createApiKey({ name: "My MacBook" }, insertFn);

    expect(result.name).toBe("My MacBook");
    expect(result.key).toMatch(/^ak_/);
    expect(result.key.length).toBeGreaterThan(40);
    expect(result.createdAt).toBe(dbCreatedAt.toISOString());
    // No scopes asked for means the full-power key older callers expect.
    expect(result.scopes).toEqual(["admin"]);
    expect(result.expiresAt).toBeNull();

    expect(insertFn).toHaveBeenCalledTimes(1);
    const data = insertFn.mock.calls[0][0];
    expect(data.name).toBe("My MacBook");
    expect(data.key).toBeDefined();
    expect(data.key).toMatch(/^ak_/);
    expect(data.id).toBe(result.id);
    expect(data.scopes).toBe("admin");
    expect(data.expiresAt).toBeNull();
  });

  it("stores the requested scopes and expiry", async () => {
    const insertFn = vi
      .fn<InsertApiKeyFn>()
      .mockResolvedValue({ createdAt: new Date("2026-06-14T12:00:00.000Z") });
    const expiresAt = "2026-06-15T00:00:00.000Z";

    const result = await createApiKey(
      { name: "host", scopes: ["users", "status"], expiresAt },
      insertFn,
    );

    expect(insertFn.mock.calls[0][0].scopes).toBe("status,users");
    expect(insertFn.mock.calls[0][0].expiresAt).toBe(expiresAt);
    expect(result.scopes).toEqual(["status", "users"]);
    expect(result.expiresAt).toBe(expiresAt);
  });
});

describe("listApiKeys", () => {
  it("returns all API keys", async () => {
    const listFn = vi.fn<ListApiKeysFn>().mockResolvedValue([
      {
        id: "k1",
        name: "MacBook",
        key: "ak_1234567890abcdefghij",
        scopes: "admin",
        expiresAt: null,
        createdAt: new Date("2026-06-14T00:00:00Z"),
      },
      {
        id: "k2",
        name: "iPhone",
        key: "ak_short",
        scopes: "status,users",
        expiresAt: "2026-07-01T00:00:00.000Z",
        createdAt: new Date("2026-06-15T00:00:00Z"),
      },
    ]);

    const result = await listApiKeys(listFn);

    expect(result.apiKeys).toHaveLength(2);
    expect(result.apiKeys[0]).toEqual({
      id: "k1",
      name: "MacBook",
      key: "ak_12345***********************ghij",
      scopes: ["admin"],
      expiresAt: null,
      createdAt: "2026-06-14T00:00:00.000Z",
    });
    expect(result.apiKeys[1]).toEqual({
      id: "k2",
      name: "iPhone",
      key: "ak_short",
      scopes: ["status", "users"],
      expiresAt: "2026-07-01T00:00:00.000Z",
      createdAt: "2026-06-15T00:00:00.000Z",
    });
  });

  it("returns empty list when there are no API keys", async () => {
    const listFn = vi.fn<ListApiKeysFn>().mockResolvedValue([]);

    const result = await listApiKeys(listFn);

    expect(result.apiKeys).toEqual([]);
  });
});

describe("revokeApiKey", () => {
  it("calls deleteFn with keyId", async () => {
    const deleteFn = vi.fn<DeleteApiKeyFn>();

    await revokeApiKey("key-123", deleteFn);

    expect(deleteFn).toHaveBeenCalledWith("key-123");
    expect(deleteFn).toHaveBeenCalledTimes(1);
  });
});

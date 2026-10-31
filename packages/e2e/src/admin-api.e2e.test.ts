import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_MAX_FILE_BYTES } from "../../shared/src/index";
import { startTestServer, type TestServer } from "./harness/server";

/**
 * The admin API is what an admin client reads in-band, and this layer is the
 * one that proves the two things a unit test cannot:
 *
 *   1. it answers in a **Vite-processed** consumer (the migration counts come from
 *      the chain module in the server source, not from a loader that only exists
 *      inside the built binary); and
 *   2. the scope and expiry rules of a host key hold at the route, not just in the
 *      middleware's own unit test.
 */
const SERVER_PKG = fileURLToPath(new URL("../../server/", import.meta.url));

/** How many migrations the chain on disk holds — what the route must report. */
function migrationCountOnDisk(): number {
  const drizzleDir = join(SERVER_PKG, "drizzle");
  return readdirSync(drizzleDir).filter((name) =>
    existsSync(join(drizzleDir, name, "migration.sql")),
  ).length;
}

/** Seed one extra host key into the running server's database. */
function seedHostKey(
  server: TestServer,
  key: string,
  scopes: string,
  expiresAt: string | null,
): void {
  const sqlite = new Database(join(server.rootDir, "courier.db"));
  try {
    sqlite
      .prepare("INSERT INTO api_keys (id, name, key, scopes, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(`id-${key}`, `seeded-${key}`, key, scopes, expiresAt);
  } finally {
    sqlite.close();
  }
}

async function get(server: TestServer, path: string, key: string) {
  const response = await fetch(`${server.serverUrl}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function patchUser(server: TestServer, id: string, body: Record<string, unknown>) {
  const response = await fetch(`${server.serverUrl}/api/users/${id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${server.hostKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("admin API", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer("admin api user");
  });

  afterAll(async () => {
    await server.close();
  });

  it("reports storage, counts and the migration pair over HTTP", async () => {
    const { status, body } = await get(server, "/api/admin/status", server.hostKey);

    expect(status).toBe(200);
    // A fresh server holds one user (the harness created it) and no content.
    expect(body.usersCount).toBe(1);
    expect(body.vaultsCount).toBe(0);
    expect(body.storageUsedBytes).toBe(0);
    expect(body.blobCount).toBe(0);
    // The filesystem capacity is answered in-band, so the page needs no SSH for
    // it while the process is alive.
    expect(typeof body.diskTotalBytes).toBe("number");
    expect(typeof body.diskUsedBytes).toBe("number");
    expect(typeof body.diskFreeBytes).toBe("number");
    expect(body.diskTotalBytes as number).toBeGreaterThanOrEqual(0);
    // The build marker is served in-band too, so the release check needs no SSH.
    expect(typeof body.binarySha256).toBe("string");
    expect(typeof body.binarySize).toBe("number");
    // The pair the upgrade flow needs, straight from the chain module.
    expect(body.migrationsKnown).toBe(migrationCountOnDisk());
    expect(typeof body.migrationsApplied).toBe("number");
    expect(typeof body.version).toBe("string");
  });

  it("samples the running process", async () => {
    const first = await get(server, "/api/admin/runtime", server.hostKey);
    expect(first.status).toBe(200);
    expect(first.body.pid).toBeGreaterThan(0);
    expect(first.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    // `bun/<version>`: `process.version` carries the compatibility version, so the
    // field names the runtime that is actually running.
    expect(String(first.body.runtime)).toMatch(/^bun\/\d+\.\d+\.\d+/);
    expect(first.body.memoryBytes).toBeGreaterThan(0);
    expect(first.body.cpuCount).toBeGreaterThanOrEqual(1);
    expect(first.body.loadAverage).toHaveLength(3);
    expect(first.body.onlineUsers).toBe(0);
    expect(first.body.onlineVaults).toBe(0);

    // A second read has a previous CPU sample to compare against, so it reports a
    // percentage — the first one deliberately reports null rather than zero.
    const second = await get(server, "/api/admin/runtime", server.hostKey);
    expect(second.status).toBe(200);
    expect(typeof second.body.cpuPercent).toBe("number");
    expect(second.body.cpuPercent as number).toBeGreaterThanOrEqual(0);
    expect(second.body.cpuMicros as number).toBeGreaterThanOrEqual(first.body.cpuMicros as number);
  });

  it("names the account a user key belongs to, and nothing more", async () => {
    const { status, body } = await get(server, "/api/me", server.userKey);

    expect(status).toBe(200);
    // The name the harness created the user with — this is what the plugin shows
    // in its account row.
    expect(body.name).toBe("admin api user");
    expect(body.id).toBe(server.userId);
    expect(body.usedBytes).toBe(0);
    // The per-key file cap: the service's default for an account that never set one.
    expect(body.maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
    // A masked key is safe to show; the credential itself is not here.
    expect(body.maskedKey).toMatch(/^ck_.+\*{4}.+$/);
    expect(body.maskedKey).not.toBe(server.userKey);
    // Never the credential itself.
    expect(body).not.toHaveProperty("key");
  });

  it("lists keys masked and reveals one only on request", async () => {
    const list = await get(server, "/api/users", server.hostKey);
    expect(list.status).toBe(200);
    const users = list.body.users as Array<Record<string, unknown>>;
    const account = users.find((user) => user.id === server.userId);
    expect(account?.maskedKey).toMatch(/^ck_.+\*{4}.+$/);
    expect(account?.maskedKey).not.toBe(server.userKey);
    expect(account).not.toHaveProperty("key");

    const revealed = await get(server, `/api/users/${server.userId}/key`, server.hostKey);
    expect(revealed.status).toBe(200);
    expect(revealed.body.key).toBe(server.userKey);

    // The reveal is host-key territory, like the rest of /api/users.
    const refused = await get(server, `/api/users/${server.userId}/key`, server.userKey);
    expect(refused.status).toBe(401);
  });

  it("lets the host change a key's file cap, and reports it to that key", async () => {
    try {
      const patched = await patchUser(server, server.userId, { maxFileBytes: 8 });
      expect(patched.status).toBe(200);
      expect(patched.body.maxFileBytes).toBe(8);

      const { body } = await get(server, "/api/me", server.userKey);
      expect(body.maxFileBytes).toBe(8);

      // 0 is a real value ("unlimited"), not "clear": it must round-trip.
      const unlimited = await patchUser(server, server.userId, { maxFileBytes: 0 });
      expect(unlimited.status).toBe(200);
      expect((await get(server, "/api/me", server.userKey)).body.maxFileBytes).toBe(0);
    } finally {
      await patchUser(server, server.userId, { maxFileBytes: DEFAULT_MAX_FILE_BYTES });
    }
  });

  it("refuses a host key at /api/me", async () => {
    // `ak_` is an admin credential, not an account: there is no "me" to name.
    const { status, body } = await get(server, "/api/me", server.hostKey);
    expect(status).toBe(401);
    expect(body.error).toBe("UNAUTHORIZED");
  });

  it("refuses a key that lacks the scope, and one that has expired", async () => {
    seedHostKey(server, "ak_status_only", "status", null);
    seedHostKey(server, "ak_expired", "admin", "2020-01-01T00:00:00.000Z");

    // `status` is enough for the admin reads...
    const allowed = await get(server, "/api/admin/runtime", "ak_status_only");
    expect(allowed.status).toBe(200);

    // ...but not for managing users.
    const refused = await get(server, "/api/users", "ak_status_only");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("INSUFFICIENT_SCOPE");

    const expired = await get(server, "/api/admin/status", "ak_expired");
    expect(expired.status).toBe(403);
    expect(expired.body.error).toBe("KEY_EXPIRED");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./harness/server";

/**
 * How many vaults one user key may own.
 *
 * The allowance is per account, defaults to one, and is enforced on
 * `POST /api/vaults` — the same request every client makes when it creates a
 * vault, so a unit test on the insert cannot tell whether the *route* actually
 * asks. These cases drive the real route and the real SQLite transaction:
 * deleting a vault must free its slot, raising the allowance must take effect on
 * the next request, and `0` must mean unlimited.
 */

async function createUser(
  server: TestServer,
  name: string,
  maxVaults?: number,
): Promise<{ id: string; key: string }> {
  const response = await fetch(`${server.serverUrl}/api/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${server.hostKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...(maxVaults === undefined ? {} : { maxVaults }) }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; key: string };
}

async function patchUser(
  server: TestServer,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${server.serverUrl}/api/users/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${server.hostKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  expect(response.status).toBe(200);
}

async function createVault(
  server: TestServer,
  userKey: string,
  name: string,
): Promise<{ status: number; id?: string; error?: string }> {
  const response = await fetch(`${server.serverUrl}/api/vaults`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, encryptionSalt: "salt", keyCheck: "canary" }),
  });
  const body = (await response.json()) as { id?: string; error?: string };
  return { status: response.status, ...body };
}

async function listVaults(server: TestServer, userKey: string): Promise<Array<{ id: string }>> {
  const response = await fetch(`${server.serverUrl}/api/vaults`, {
    headers: { Authorization: `Bearer ${userKey}` },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { vaults: Array<{ id: string }> }).vaults;
}

async function me(server: TestServer, userKey: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${server.serverUrl}/api/me`, {
    headers: { Authorization: `Bearer ${userKey}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe("vault allowance", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer("vault allowance user");
  });

  afterAll(async () => {
    await server.close();
  });

  it("defaults to one vault and refuses the second", async () => {
    const user = await createUser(server, "一把锁的人");

    expect(await me(server, user.key)).toMatchObject({ maxVaults: 1, vaultsCount: 0 });

    const first = await createVault(server, user.key, "第一个");
    expect(first.status).toBe(201);

    const second = await createVault(server, user.key, "第二个");
    expect(second.status).toBe(409);
    expect(second.error).toBe("VAULT_LIMIT_REACHED");

    expect(await listVaults(server, user.key)).toHaveLength(1);
    expect(await me(server, user.key)).toMatchObject({ maxVaults: 1, vaultsCount: 1 });
  });

  it("takes effect on the next request when the allowance is raised", async () => {
    const user = await createUser(server, "加额度的人");
    expect((await createVault(server, user.key, "一")).status).toBe(201);
    expect((await createVault(server, user.key, "二")).status).toBe(409);

    await patchUser(server, user.id, { maxVaults: 2 });
    expect((await createVault(server, user.key, "二")).status).toBe(201);
    expect((await createVault(server, user.key, "三")).status).toBe(409);
  });

  it("frees a slot when a vault is deleted", async () => {
    const user = await createUser(server, "删库的人");
    const first = await createVault(server, user.key, "旧的");
    expect(first.status).toBe(201);
    expect((await createVault(server, user.key, "被拒的")).status).toBe(409);

    const refusedId = first.id;
    expect(refusedId).toBeTruthy();
    const deleted = await fetch(`${server.serverUrl}/api/vaults/${refusedId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${user.key}` },
    });
    expect(deleted.status).toBe(204);

    expect((await createVault(server, user.key, "新的")).status).toBe(201);
  });

  it("treats 0 as unlimited", async () => {
    const user = await createUser(server, "不限库数的人", 0);

    for (const name of ["一", "二", "三", "四"]) {
      expect((await createVault(server, user.key, name)).status).toBe(201);
    }
    expect(await listVaults(server, user.key)).toHaveLength(4);
    expect(await me(server, user.key)).toMatchObject({ maxVaults: 0, vaultsCount: 4 });
  });
});

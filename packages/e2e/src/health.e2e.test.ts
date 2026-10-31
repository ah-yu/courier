import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./harness/server";

/**
 * The liveness probe `docs/api.md` §1 documents.
 *
 * It is the one route with no auth and no data, and the one a deploy script or a
 * monitor polls, so what is worth pinning is that it answers **without** a key and
 * with the documented shape — `{ status, timestamp }` — rather than merely that the
 * path exists. The doc described it long before the code did; this keeps the two
 * from drifting apart again.
 */
describe("health e2e — the liveness probe the API doc describes", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer("health user");
  });

  afterAll(async () => {
    await server.close();
  });

  it("answers without a key, with the documented shape", async () => {
    const response = await fetch(`${server.serverUrl}/api/health`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status?: string; timestamp?: string };
    expect(body.status).toBe("ok");
    // A stamp a monitor can parse, not just some string.
    expect(Number.isNaN(Date.parse(body.timestamp ?? ""))).toBe(false);
  });
});

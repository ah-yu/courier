import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runApikeyList, runApikeyCreate, runApikeyDelete } from "./apikey";
import type { ApikeyCliActions } from "./apikey";

function mockActions(overrides: Partial<ApikeyCliActions> = {}): ApikeyCliActions {
  return {
    insertApiKey: vi.fn().mockResolvedValue({ createdAt: new Date("2026-07-01T00:00:00Z") }),
    listAll: vi.fn().mockResolvedValue([]),
    deleteById: vi.fn().mockResolvedValue(undefined),
    findApiKeyById: vi.fn().mockResolvedValue({ id: "k1" }),
    ...overrides,
  };
}

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  stdoutSpy.mockRestore();
  errorSpy.mockRestore();
});

/** Full stdout content — used to assert JSON output purity. */
function stdout(): string {
  return stdoutSpy.mock.calls.map((args: unknown[]) => String(args[0])).join("");
}

/** Number of lines written to stdout. */
function stdoutLines(): string[] {
  return stdout().split("\n").filter(Boolean);
}

describe("runApikeyList", () => {
  const keys = [
    {
      id: "k1",
      name: "laptop",
      key: "ak_aaaabbbbccccddddeeee",
      scopes: "admin",
      expiresAt: null,
      createdAt: new Date("2026-07-01T00:00:00Z"),
    },
    {
      id: "k2",
      name: "phone",
      key: "ak_111122223333444455556",
      scopes: "status,users",
      expiresAt: "2026-08-01T00:00:00.000Z",
      createdAt: new Date("2026-07-02T00:00:00Z"),
    },
  ];

  it("--json prints a single parseable JSON line to stdout", async () => {
    const actions = mockActions({ listAll: vi.fn().mockResolvedValue(keys) });

    const code = await runApikeyList(true, actions);

    expect(code).toBe(0);
    expect(stdoutLines()).toHaveLength(1);
    const parsed = JSON.parse(stdout());
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe("laptop");
    // Keys are masked in list output
    expect(parsed[0].key).not.toBe(keys[0].key);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("table output lists all keys", async () => {
    const actions = mockActions({ listAll: vi.fn().mockResolvedValue(keys) });

    const code = await runApikeyList(false, actions);

    expect(code).toBe(0);
    expect(stdout()).toContain("laptop");
    expect(stdout()).toContain("phone");
  });

  it("prints placeholder when there are no keys", async () => {
    const code = await runApikeyList(false, mockActions());

    expect(code).toBe(0);
    expect(stdout()).toContain("No API keys found.");
  });
});

describe("runApikeyCreate", () => {
  it("prints exactly one line: the raw key", async () => {
    const actions = mockActions();

    const code = await runApikeyCreate("laptop", { json: false }, actions);

    expect(code).toBe(0);
    expect(stdoutLines()).toHaveLength(1);
    expect(stdoutLines()[0]).toMatch(/^ak_[A-Za-z0-9_-]+$/);
    expect(actions.insertApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ name: "laptop", key: expect.stringMatching(/^ak_/) }),
    );
  });

  it("--json prints the whole created record, once", async () => {
    const actions = mockActions();

    const code = await runApikeyCreate("host", { json: true, scopes: "status,users" }, actions);

    expect(code).toBe(0);
    expect(stdoutLines()).toHaveLength(1);
    const parsed = JSON.parse(stdout()) as { key: string; scopes: string[]; expiresAt: null };
    expect(parsed.key).toMatch(/^ak_/);
    expect(parsed.scopes).toEqual(["status", "users"]);
    expect(parsed.expiresAt).toBeNull();
    expect(actions.insertApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: "status,users", expiresAt: null }),
    );
  });

  it("--expires-in turns a duration into an absolute expiry", async () => {
    const actions = mockActions();

    const code = await runApikeyCreate("short-lived", { json: false, expiresIn: "12h" }, actions);

    expect(code).toBe(0);
    const data = (actions.insertApiKey as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      expiresAt: string;
    };
    const expires = new Date(data.expiresAt).getTime();
    // Roughly twelve hours out, without depending on the exact second.
    expect(expires - Date.now()).toBeGreaterThan(11 * 3_600_000);
    expect(expires - Date.now()).toBeLessThan(13 * 3_600_000);
  });

  it("rejects an unknown scope and a bad duration without writing", async () => {
    const actions = mockActions();

    expect(await runApikeyCreate("x", { json: false, scopes: "root" }, actions)).toBe(1);
    expect(await runApikeyCreate("x", { json: false, expiresIn: "soon" }, actions)).toBe(1);
    expect(actions.insertApiKey).not.toHaveBeenCalled();
  });
});

describe("runApikeyDelete", () => {
  it("revokes the key", async () => {
    const actions = mockActions();

    const code = await runApikeyDelete("k1", actions);

    expect(code).toBe(0);
    expect(actions.deleteById).toHaveBeenCalledWith("k1");
    expect(stdout()).toContain('"k1" revoked');
  });

  it("returns 1 with a stderr message when the key does not exist", async () => {
    const actions = mockActions({ findApiKeyById: vi.fn().mockResolvedValue(undefined) });

    const code = await runApikeyDelete("missing", actions);

    expect(code).toBe(1);
    expect(actions.deleteById).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('Error: API key "missing" not found.');
    expect(stdout()).toBe("");
  });
});

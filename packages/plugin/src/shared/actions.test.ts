import { describe, expect, it } from "vitest";
import {
  parsePushBody,
  type HttpTransport,
  type TransportRequest,
  type TransportResponse,
} from "@courier/shared";
import { createPluginActions } from "./actions";
import { DEFAULT_SETTINGS, type CourierSettings } from "./settings";

/**
 * The plugin's action surface, unit-tested at last.
 *
 * This module imports nothing from `obsidian` — the transport is injected — which
 * is what makes the endpoint wiring testable at L0. In production the transport
 * is `requestUrl` (`main.ts`), and the L2 suite covers that adapter.
 */

function fakeTransport(response: Partial<TransportResponse> = {}): {
  transport: HttpTransport;
  calls: TransportRequest[];
} {
  const calls: TransportRequest[] = [];
  const transport: HttpTransport = async (request) => {
    calls.push(request);
    return {
      status: 200,
      text: "",
      json: null,
      arrayBuffer: new ArrayBuffer(0),
      ...response,
    };
  };
  return { transport, calls };
}

function actionsWith(options: {
  transport: HttpTransport;
  settings?: Partial<CourierSettings>;
  userKey?: string | null;
}) {
  let settings: CourierSettings = {
    ...DEFAULT_SETTINGS,
    serverUrl: "http://srv:3002",
    userKey: "ck_context",
    deviceName: "My Device",
    ...options.settings,
  };
  const actions = createPluginActions({
    transport: options.transport,
    getSettings: () => settings,
    getUserKey: () => (options.userKey === undefined ? "ck_context" : options.userKey),
  });
  return {
    actions,
    setSettings: (patch: Partial<CourierSettings>) => {
      settings = { ...settings, ...patch };
    },
  };
}

describe("createPluginActions", () => {
  it("runs every vault call against the configured server, with the user key", async () => {
    const { transport, calls } = fakeTransport({
      json: { id: "v1", name: "notes", createdAt: "2026-01-01" },
    });
    const { actions } = actionsWith({ transport });

    await actions.createVault("notes", "salt", "canary");
    expect(calls[0]!.url).toBe("http://srv:3002/api/vaults");
    expect(calls[0]!.headers.Authorization).toBe("Bearer ck_context");
    expect(calls[0]!.method).toBe("POST");
  });

  it("follows a server address the user changes while the plugin is running", async () => {
    const { transport, calls } = fakeTransport({ json: { vaults: [] } });
    const { actions, setSettings } = actionsWith({ transport });

    await actions.listVaults();
    setSettings({ serverUrl: "https://other.example" });
    await actions.listVaults();

    expect(calls.map((call) => call.url)).toEqual([
      "http://srv:3002/api/vaults",
      "https://other.example/api/vaults",
    ]);
  });

  it("reads version content as bytes and never as JSON", async () => {
    const { transport } = fakeTransport({
      arrayBuffer: new Uint8Array([4, 5, 6]).buffer,
      json: null,
    });
    const { actions } = actionsWith({ transport });

    expect([...(await actions.getVersionContent("v1", "hash"))]).toEqual([4, 5, 6]);
  });

  it("builds the engine's api under the key it is given, not the context key", async () => {
    const { transport, calls } = fakeTransport({ json: { results: [] } });
    const { actions } = actionsWith({ transport, userKey: "ck_context" });

    const api = actions.buildSyncApi("ck_engine");
    await api.push("v1", []);

    expect(calls[0]!.headers.Authorization).toBe("Bearer ck_engine");
  });

  it("states the current device label in every push, and the session id when known", async () => {
    const { transport, calls } = fakeTransport({ json: { results: [] } });
    const { actions, setSettings } = actionsWith({
      transport,
      settings: { deviceName: "MacBook" },
    });

    const api = actions.buildSyncApi("ck_engine");
    await api.push("v1", []);
    setSettings({ deviceName: "书房笔记本" });
    api.setSessionId?.("session-1");
    await api.push("v1", []);

    const first = parsePushBody(new Uint8Array(calls[0]!.body as Uint8Array));
    const second = parsePushBody(new Uint8Array(calls[1]!.body as Uint8Array));
    expect(first.deviceName).toBe("MacBook");
    expect(second.deviceName).toBe("书房笔记本");
    expect(calls[1]!.headers["X-Courier-Session-Id"]).toBe("session-1");
  });
});

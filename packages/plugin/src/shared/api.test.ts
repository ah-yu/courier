import { describe, expect, it } from "vitest";
import { getServerUrl, getWsUrl } from "./api";
import { DEFAULT_SETTINGS, type CourierSettings } from "./settings";

/**
 * The two URL helpers the settings page and the engine host share.
 *
 * The error mapping that used to live beside them (`handleApiError`,
 * `ApiClientError`) is now `@courier/shared`'s, because the server's error body
 * is one contract for every client — its tests moved with it
 * (`packages/shared/src/http.test.ts`).
 */
describe("getServerUrl / getWsUrl", () => {
  it("falls back to the default server URL when unset", () => {
    const settings: CourierSettings = { ...DEFAULT_SETTINGS, serverUrl: null };
    expect(getServerUrl(settings)).toBe("http://localhost:3002");
  });

  it("uses the configured server URL when set", () => {
    const settings: CourierSettings = {
      ...DEFAULT_SETTINGS,
      serverUrl: "http://vault.example.com:3002",
    };
    expect(getServerUrl(settings)).toBe("http://vault.example.com:3002");
  });

  it("derives ws from http", () => {
    const settings: CourierSettings = { ...DEFAULT_SETTINGS, serverUrl: "http://localhost:3002" };
    expect(getWsUrl(settings)).toBe("ws://localhost:3002");
  });

  it("derives wss from https", () => {
    const settings: CourierSettings = {
      ...DEFAULT_SETTINGS,
      serverUrl: "https://vault.example.com",
    };
    expect(getWsUrl(settings)).toBe("wss://vault.example.com");
  });
});

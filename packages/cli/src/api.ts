import {
  createCourierClient,
  type CourierClient,
  type HttpTransport,
  type TransportRequest,
  type TransportResponse,
} from "@courier/shared";
import { createSyncApi, type SyncApi } from "@courier/engine";

/**
 * The headless CLI's network layer.
 *
 * It is deliberately thin: the endpoints, URLs, auth and error mapping live in
 * `@courier/shared`'s HTTP client (the same one the plugin uses, over the same
 * tests), and the push frame lives in `@courier/engine`'s `createSyncApi`. What
 * is left — and what this module owns — is the transport: global `fetch`, turned
 * into the response shape `requestUrl` already answers with.
 */

/**
 * A `fetch`-backed transport.
 *
 * The body is read once into bytes; `text` and `json` are **lazy getters**, the same
 * shape Obsidian's `requestUrl` transport exposes. That matters because a version's
 * content route answers raw ciphertext: decoding it as UTF-8 used to cost a pass over
 * every byte, a string twice the payload's size, and a `JSON.parse` that was always
 * thrown away — measured at ~0.56 s of a 50 MiB download's 0.94 s (the plugin's lazy
 * transport did the same download in 0.33 s). A caller that wants JSON (every route but
 * content) still reads `json` and pays the decode once; a caller that wants bytes never
 * does. `fetchImpl` is injectable for tests.
 */
export function createFetchTransport(fetchImpl: typeof fetch = fetch): HttpTransport {
  return async (request: TransportRequest): Promise<TransportResponse> => {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body as BodyInit | undefined,
    });

    const arrayBuffer = await response.arrayBuffer();
    let text: string | null = null;
    let jsonParsed = false;
    let json: unknown = null;

    /** The body as UTF-8, decoded the first time something asks for it. */
    const textOf = (): string => (text ??= new TextDecoder().decode(arrayBuffer));

    return {
      status: response.status,
      // Lower-cased by `Headers`; the shared client reads `retry-after` from here.
      headers: Object.fromEntries(response.headers.entries()),
      get text() {
        return textOf();
      },
      get json() {
        if (!jsonParsed) {
          jsonParsed = true;
          try {
            const body = textOf();
            json = body ? JSON.parse(body) : null;
          } catch {
            // A non-JSON body: binary content, a 204, a proxy error page.
          }
        }
        return json;
      },
      get arrayBuffer() {
        return arrayBuffer;
      },
    };
  };
}

export interface CliClientOptions {
  serverUrl: string;
  /** The single `ck_` user key shared by all of this user's clients. */
  userKey: string;
  /** Overridable fetch for tests. */
  fetchImpl?: typeof fetch;
}

/** Every REST call the CLI makes outside the sync protocol (vaults, crypto material). */
export function createCliClient(options: CliClientOptions): CourierClient {
  return createCourierClient({
    baseUrl: options.serverUrl,
    getUserKey: () => options.userKey,
    transport: createFetchTransport(options.fetchImpl),
  });
}

export interface CliSyncApiOptions extends CliClientOptions {
  /**
   * The label stated on every push, read at push time.
   *
   * A daemon reads it from its config file, so `courier-cli device rename` — a
   * separate process writing that file — applies to the next push instead of
   * requiring a restart.
   */
  getDeviceName: () => string;
}

/** The engine's network layer for the CLI (also used by the e2e harness). */
export function createCliSyncApi(options: CliSyncApiOptions): SyncApi {
  return createSyncApi(createCliClient(options), options.getDeviceName);
}

import { setRequestUrlHandler, type RequestUrlParam } from "./obsidian-stub";

/**
 * Transport for the plugin's `requestUrl` calls.
 *
 * The real `requestUrl` is implemented by the Obsidian app (Electron's `net`
 * module) and cannot be exercised outside it, but everything the plugin is
 * responsible for — URL, method, headers, body, status/JSON handling, and the
 * binary content route — can: this forwards to global `fetch` against the real
 * test server and records every call so tests can assert the wiring precisely.
 *
 * This closes a gap that used to be covered only by hand.
 */

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The request body as it went out: JSON text, or the push frame's bytes. */
  body: string | ArrayBuffer | undefined;
  /** Byte length of the body, whichever shape it had — how a test asserts "no content sent". */
  bodyBytes: number;
  status: number;
}

const recorded: RecordedRequest[] = [];

/** Every request the plugin made through `requestUrl`, in order. */
export function recordedRequests(): readonly RecordedRequest[] {
  return recorded;
}

/** Forget recorded requests (call in `beforeEach`). */
export function resetRecordedRequests(): void {
  recorded.length = 0;
}

/** Recorded requests whose URL matches `pattern`. */
export function requestsMatching(pattern: RegExp): RecordedRequest[] {
  return recorded.filter((request) => pattern.test(request.url));
}

/** Point the stubbed `requestUrl` at global `fetch`. */
export function installFetchTransport(): void {
  setRequestUrlHandler(async (param: RequestUrlParam) => {
    const headers: Record<string, string> = { ...param.headers };
    if (param.contentType) headers["Content-Type"] = param.contentType;

    const response = await fetch(param.url, {
      method: param.method ?? "GET",
      headers,
      body: param.body as BodyInit | undefined,
    });

    // Read the body once, in both shapes: the JSON routes are asserted through
    // `text`/`json`, the version-content route through `arrayBuffer`.
    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const text = new TextDecoder().decode(bytes);
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON body (binary content, a 204, a proxy error page) — `json` stays
      // null, which is what the plugin's handleApiError path expects.
    }

    recorded.push({
      url: param.url,
      method: param.method ?? "GET",
      headers,
      body: param.body,
      bodyBytes:
        typeof param.body === "string"
          ? new TextEncoder().encode(param.body).byteLength
          : (param.body?.byteLength ?? 0),
      status: response.status,
    });

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text,
      json,
      arrayBuffer,
    };
  });
}

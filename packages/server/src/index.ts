import { createWsHub, type WsHub } from "./handlers/ws-handlers";

/**
 * The WebSocket hub the routes announce changes to.
 *
 * One composition point: `startServer` owns the socket listener, so it builds the
 * hub and hands it to both the route table and the connection handlers. Nothing
 * reaches it through module state, so a second server in the same process (a
 * test's, or a future embedded one) cannot announce its pushes to the first one's
 * subscribers.
 *
 * There is no `app` any more: every route lives on the Bun route table
 * (`routes/*.ts`), and the listener's `fetch` is only the 404 fallback.
 */
export function createServerApp(): { hub: WsHub } {
  return { hub: createWsHub() };
}

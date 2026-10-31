import type { ApiErrorCode, WsServerMessage } from "@courier/shared";

export type WsConnectionState = "disconnected" | "connecting" | "connected" | "error";

export type WsEvent =
  | { type: "vault_deleted"; vaultId: string }
  | { type: "user_key_revoked" }
  | { type: "user_key_disabled" }
  | {
      type: "subscribe_error";
      /** Why the server refused the subscription, when it said (see `WsServerMessage`). */
      code?: ApiErrorCode;
      message: string;
    }
  | { type: "state_change"; state: WsConnectionState }
  | { type: "file_pushed"; fileId: string; versionId: string; deviceName?: string };

export type WsEventHandler = (event: WsEvent) => void;

export interface SyncWebSocketOptions {
  /** WebSocket base URL (ws://…). */
  wsUrl: string;
  vaultId: string;
  /** Single user key (`ck_...`) shared by all of the user's devices. */
  userKey: string;
  /**
   * The label this client states for itself, so a peer's `file_pushed`
   * notification can name the machine that made the change. It is not an identity:
   * nothing is registered or verified, and changing it affects only future events.
   */
  deviceName: string;
  onEvent: WsEventHandler;
}

/**
 * WebSocket client used by plugin and CLI sync hosts. Subscribes with the
 * user key plus a self-declared device label (there is no per-device credential
 * and no device registry), keeps the connection alive with ping/pong and
 * exponential-backoff reconnect.
 *
 * Uses the global `WebSocket` (Obsidian runtime, browsers, Bun).
 */
export class SyncWebSocket {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMessageTimer: ReturnType<typeof setTimeout> | null = null;
  private state: WsConnectionState = "disconnected";
  private manualDisconnect = false;
  private sessionId: string | null = null;

  constructor(private opts: SyncWebSocketOptions) {}

  private setState(state: WsConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onEvent({ type: "state_change", state });
  }

  connect(): void {
    if (this.ws) this.disconnect();
    this.manualDisconnect = false;
    this.setState("connecting");

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.wsUrl);
    } catch (err) {
      console.error("Courier WS: WebSocket constructor threw:", err);
      this.setState("error");
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.send({
        type: "subscribe",
        vaultId: this.opts.vaultId,
        userKey: this.opts.userKey,
        deviceName: this.opts.deviceName,
      });
      this.resetLastMessageTimer();
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      this.resetLastMessageTimer();
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(event.data as string) as WsServerMessage;
      } catch {
        return;
      }

      switch (msg.type) {
        case "subscribe_success":
          this.sessionId = msg.sessionId;
          this.setState("connected");
          this.reconnectAttempts = 0;
          break;
        case "subscribe_error":
          // Report the refusal and let the ordinary close path reconnect with backoff.
          // This used to `disconnect()`, which sets `manualDisconnect` and therefore
          // never reconnected: a key that expired (or a vault that was deleted) while
          // the app was closed left the socket dead for the rest of the session, even
          // after the host renewed the key. A terminal code is the host's decision to
          // make, and it stops the host itself.
          this.opts.onEvent({
            type: "subscribe_error",
            code: msg.code,
            message: msg.message,
          });
          this.closeForReconnect();
          break;
        case "vault_deleted":
          this.opts.onEvent({ type: "vault_deleted", vaultId: msg.vaultId });
          this.disconnect();
          break;
        case "api_key_revoked":
          this.opts.onEvent({ type: "user_key_revoked" });
          this.setState("error");
          this.disconnect();
          break;
        case "api_key_disabled":
          // The account still owns everything; only the key stopped authenticating.
          // The host pauses rather than dropping the binding, so re-enabling the key
          // is a resume, not a re-setup.
          this.opts.onEvent({ type: "user_key_disabled" });
          this.setState("error");
          this.disconnect();
          break;
        case "ping":
          this.send({ type: "pong" });
          break;
        case "file_pushed":
          this.opts.onEvent({
            type: "file_pushed",
            fileId: msg.fileId,
            versionId: msg.versionId,
            deviceName: msg.deviceName,
          });
          break;
      }
    });

    // An `error` event is always followed by `close`, so the close handler below is the
    // only one that drives the reconnect.
    ws.addEventListener("close", () => {
      this.clearLastMessageTimer();
      this.setState("disconnected");
      this.ws = null;
      if (!this.manualDisconnect) {
        this.scheduleReconnect();
      }
    });
  }

  disconnect(): void {
    this.manualDisconnect = true;
    this.clearReconnectTimer();
    this.clearLastMessageTimer();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // already closed
      }
      this.ws = null;
    }
    this.setState("disconnected");
  }

  /**
   * Close the socket so the ordinary close handler reconnects with backoff.
   *
   * Unlike {@link disconnect}, this is not a deliberate stop: the reconnect stays
   * armed. A refused subscription is the case it exists for — the refusal may be
   * transient (a server still starting) or fixable (a key the host renews), and
   * neither is a reason to end the session's live channel for good.
   */
  private closeForReconnect(): void {
    this.clearLastMessageTimer();
    if (!this.ws) {
      this.scheduleReconnect();
      return;
    }
    try {
      this.ws.close();
    } catch {
      // No `close` event will follow, so this is the only place that can reconnect.
      this.ws = null;
      this.setState("disconnected");
      this.scheduleReconnect();
    }
  }

  getState(): WsConnectionState {
    return this.state;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  send(
    msg:
      | { type: "subscribe"; vaultId: string; userKey: string; deviceName: string }
      | { type: "pong" },
  ): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ── Internals ──

  private scheduleReconnect(): void {
    if (this.manualDisconnect) return;
    // One timer at a time: a refusal and the close event it causes must not each arm
    // a reconnect (the second timer used to be lost, and two connections followed).
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private resetLastMessageTimer(): void {
    this.clearLastMessageTimer();
    this.lastMessageTimer = setTimeout(() => {
      if (this.state === "connected" && this.ws) {
        try {
          this.ws.close();
        } catch {
          // ignore
        }
      }
    }, 60_000);
  }

  private clearLastMessageTimer(): void {
    if (this.lastMessageTimer !== null) {
      clearTimeout(this.lastMessageTimer);
      this.lastMessageTimer = null;
    }
  }
}

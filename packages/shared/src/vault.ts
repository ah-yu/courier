import type { ApiErrorCode } from "./errors";

/**
 * Fixed plaintext encrypted with the vault's AES-256-GCM key at creation time.
 * Clients verify a password locally by decrypting the stored keyCheck and
 * comparing with this value — the password itself never reaches the server.
 * Must match the engine's `verifyKeyCheck` in packages/engine/src/crypto.ts and
 * the server's `vaults.key_check` column.
 */
export const KEY_CHECK_VALUE = "courier-key-check";

export interface CreateVaultResponse {
  id: string;
  name: string;
  createdAt: string;
}

export interface VaultKeyCheckResponse {
  /** base64(iv || ciphertext || authTag) of the fixed key-check plaintext, AES-256-GCM. */
  keyCheck: string;
}

export interface VaultEncryptionSaltResponse {
  encryptionSalt: string;
}

export interface ListVaultsResponse {
  vaults: Array<{ id: string; name: string; createdAt: string }>;
}

export type WsClientMessage =
  | {
      type: "subscribe";
      vaultId: string;
      userKey: string;
      /**
       * The client's self-declared label, passed on to peers in `file_pushed` so a
       * notification can say which machine made the change. Display metadata only:
       * nothing is registered or verified against it.
       */
      deviceName?: string;
    }
  | { type: "unsubscribe"; vaultId: string }
  | { type: "pong" };

export type WsServerMessage =
  | { type: "subscribe_success"; vaultId: string; sessionId: string }
  | {
      type: "subscribe_error";
      vaultId: string;
      message: string;
      /**
       * Why the subscription was refused, in the API's own codes.
       *
       * The message is for a log line; this is what a client matches on. A terminal
       * credential code (`KEY_EXPIRED`, `KEY_DISABLED`, `UNAUTHORIZED`) and `NOT_FOUND`
       * (the vault is gone) end the binding, while anything else is worth retrying.
       * Absent when the refusal came from somewhere that has no code to give.
       */
      code?: ApiErrorCode;
    }
  | { type: "unsubscribed"; vaultId: string }
  | { type: "vault_deleted"; vaultId: string }
  | { type: "api_key_revoked"; vaultId: string }
  /**
   * The account was disabled by the host: the key, its vaults and their data are all
   * still there, but the key authenticates nothing until it is enabled again.
   *
   * Deliberately distinct from `api_key_revoked`: a revoked key is gone for good, so
   * the client drops the binding, while a disabled one is a pause the same key can be
   * resumed from.
   */
  | { type: "api_key_disabled"; vaultId: string }
  | { type: "ping" }
  | {
      type: "file_pushed";
      vaultId: string;
      fileId: string;
      versionId: string;
      /** Label the pushing client stated for itself (for display). */
      deviceName?: string;
    };

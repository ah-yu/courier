import { z } from "zod";
import { json, withAccessLog, type RouteTable } from "../http/router";
import { withErrorMapping } from "../http/auth";
import { withHostAuth, withJson } from "../http/guards";
import { findByKey } from "../lib/api-keys";
import type { WsHub } from "../handlers/ws-handlers";
import {
  createUser,
  listUsers,
  updateUser,
  deleteUser,
  revealUserKey,
} from "../handlers/users-handlers";
import {
  findUserById,
  insertUser,
  listUsers as listUsersDb,
  updateUser as updateUserDb,
  deleteUser as deleteUserDb,
  userStorageBytes,
  userVaultCount,
} from "../lib/users-db";
import { deleteVaultBlobs } from "../lib/blob-store";
import { invalidateStorageUsage, invalidateUserStorageUsage } from "../lib/storage-usage";
import { logger as processLogger } from "../lib/log";
import { config } from "../config";
import type { Logger } from "../lib/logger";

const createUserSchema = z.object({
  name: z.string().min(1).max(255),
  storageBytesLimit: z.number().int().nonnegative().nullable().optional(),
  retentionDays: z.number().int().nonnegative().nullable().optional(),
  maxFileBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  maxVaults: z.number().int().nonnegative().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  disabled: z.boolean().optional(),
});

const updateUserSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    storageBytesLimit: z.number().int().nonnegative().nullable().optional(),
    retentionDays: z.number().int().nonnegative().nullable().optional(),
    maxFileBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    maxVaults: z.number().int().nonnegative().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });

/**
 * The host-key user surface: create, list, reveal a key, patch, delete.
 *
 * Every endpoint is `ak_` territory with the `users` scope, exactly as the Hono
 * middleware chain enforced it; `withHostAuth` is that chain in one wrapper.
 */
export function userRoutes(hub: WsHub, logger: Logger = processLogger): RouteTable {
  /** Wrap one endpoint in the same three layers the other modules use. */
  const route = (
    scope: "users",
    handler: Parameters<typeof withHostAuth>[2] extends infer H ? H : never,
    schema?: z.ZodType,
  ) => {
    const guarded = schema
      ? withJson(schema, handler as never)
      : withHostAuth(findByKey, scope, handler as never);
    return withAccessLog(logger, withErrorMapping(guarded as never, logger), config.LOG_SLOW_MS);
  };

  return {
    "/api/users": {
      POST: route(
        "users",
        async (_request, body) => {
          const response = await createUser(body as z.infer<typeof createUserSchema>, insertUser);
          return json(response, 201);
        },
        createUserSchema,
      ),
      GET: route("users", async () => {
        const response = await listUsers(listUsersDb, userStorageBytes, userVaultCount);
        return json(response);
      }),
    },
    "/api/users/:id/key": {
      GET: route("users", async (request) => {
        const response = await revealUserKey(request.params.id!, findUserById);
        return json(response);
      }),
    },
    "/api/users/:id": {
      PATCH: route(
        "users",
        async (request, body) => {
          const id = request.params.id!;
          const patch = body as z.infer<typeof updateUserSchema>;
          // The handler owns the three "this would make the account unusable" rules (a
          // cap below usage, an allowance below the vaults that exist, an expiry in the
          // past); this route only supplies the facts they need.
          const response = await updateUser(id, patch, {
            find: findUserById,
            update: updateUserDb,
            usedBytes: userStorageBytes,
            vaultCount: userVaultCount,
          });
          // Disabling is an in-band stop, like deleting: the account keeps everything it
          // owns, so its sessions are told the key was **disabled** (a pause the same key
          // can be resumed from), never that it was revoked.
          if (patch.disabled === true) hub.revokeUserSessions(id, "disabled");
          return json(response);
        },
        updateUserSchema,
      ),
      DELETE: route("users", async (request) => {
        const id = request.params.id!;
        // "Delete this key" is "delete this account": its vaults go with it. A vault
        // left behind would be an owner-less row every other account can use
        // (`canAccessVault`), while its blobs are charged to nobody and never reclaimed.
        const vaultIds = await deleteUser(id, findUserById, deleteUserDb);
        // The account is gone, so its devices are told **before** the slow part:
        // reclaiming megabytes of blobs must not delay the one message that stops them
        // writing into a vault that no longer exists.
        hub.revokeUserSessions(id, "deleted");
        invalidateStorageUsage();
        invalidateUserStorageUsage(id);
        // The rows are gone, so nothing names these directories any more: their bytes
        // are reclaimed the way a vault deletion reclaims them. A failure here is **not**
        // a failed delete — the account and its chains are already committed, and
        // answering 500 would leave the caller with a request that can only be retried
        // into a 404 — so it is logged and the bytes become the sweeper's problem.
        for (const vaultId of vaultIds) {
          try {
            await deleteVaultBlobs(vaultId);
          } catch (err) {
            processLogger.error(
              `reclaiming the blobs of deleted vault ${vaultId} failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
        return new Response(null, { status: 204 });
      }),
    },
  };
}

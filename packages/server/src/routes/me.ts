import { json, withAccessLog, type RouteTable } from "../http/router";
import { withErrorMapping, withUserAuth } from "../http/auth";
import { toUserSummary } from "../handlers/users-handlers";
import { findUserByKey, userStorageBytes, userVaultCount } from "../lib/users-db";
import { config } from "../config";
import type { Logger } from "../lib/logger";

/**
 * "Which account does this user key belong to?"
 *
 * A client that holds only a `ck_` key has no other way to name the account it is
 * signed in as — the admin surface (`/api/users`) is host-key territory and lists
 * every user. This answers for the presented key only, and never returns the key
 * itself, so it is also the cheapest way to prove the key still works.
 *
 * The second module on the Bun route table, and the first with auth: it proves
 * `withUserAuth` + `withErrorMapping` compose the way the Hono middleware chain
 * did (a bad key still answers the documented 401 body).
 */
export function meRoutes(logger: Logger): RouteTable {
  const get = withUserAuth(findUserByKey, async (_request, user) =>
    json(toUserSummary(user, await userStorageBytes(user.id), await userVaultCount(user.id))),
  );

  return {
    "/api/me": {
      GET: withAccessLog(logger, withErrorMapping(get, logger), config.LOG_SLOW_MS),
    },
  };
}

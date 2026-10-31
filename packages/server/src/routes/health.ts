import { json, withAccessLog, type RouteTable } from "../http/router";
import { config } from "../config";
import type { Logger } from "../lib/logger";

/**
 * Liveness, as `docs/api.md` documents it: a constant answer, no auth, no data.
 *
 * The first module on the Bun route table — it is the one endpoint with no
 * middleware, no database and no dependency, so it proves the wiring without
 * putting anything at risk. It carries the access log itself: a Bun route
 * handler never passes through Hono's middleware chain.
 */
export function healthRoutes(logger: Logger): RouteTable {
  return {
    "/api/health": {
      GET: withAccessLog(
        logger,
        () => json({ status: "ok", timestamp: new Date().toISOString() }),
        config.LOG_SLOW_MS,
      ),
    },
  };
}

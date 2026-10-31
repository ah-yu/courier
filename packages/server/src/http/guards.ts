import type { ApiKeyScope } from "@courier/shared";
import type { z } from "zod";
import { InsufficientScopeError, UnauthorizedError, ValidationError } from "../lib/errors";
import { bearerToken } from "../lib/user-credentials";
import { assertApiKeyActive, hasScope } from "../lib/api-key-access";
import { validationDetails } from "../lib/validator";
import type { FindApiKeyFn } from "../handlers/auth-handlers";
import { readJson, type RouteHandler } from "./router";

/**
 * The Hono middleware the admin/user routes used, as Bun route wrappers.
 *
 * `withHostAuth` answers the same three refusals the middleware did, in the same
 * order (missing key → inactive key → missing scope), and `withJson` produces the
 * same 422 body `createValidator` produced — including the `details` array, which
 * `docs/api.md` documents.
 */

/** Require an `ak_` host key carrying `scope`, and hand the handler the key row. */
export function withHostAuth<T>(
  findByKey: FindApiKeyFn,
  scope: ApiKeyScope,
  handler: (request: Parameters<RouteHandler>[0], apiKey: T) => Response | Promise<Response>,
): RouteHandler {
  return async (request) => {
    const token = bearerToken(request.headers.get("authorization"), "ak_");
    const apiKey = await findByKey(token);
    if (!apiKey) throw new UnauthorizedError("Invalid or expired API key");
    assertApiKeyActive(apiKey);
    if (!hasScope(apiKey.scopes, scope)) throw new InsufficientScopeError(scope);
    return await handler(request, apiKey as unknown as T);
  };
}

/** Parse and validate a JSON body, or throw the documented 422. */
export async function parseJson<S extends z.ZodType>(
  request: Parameters<RouteHandler>[0],
  schema: S,
): Promise<z.infer<S>> {
  const raw = await readJson(request, () => new ValidationError("Expected a JSON body"));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("Validation failed", validationDetails(parsed.error.issues));
  }
  return parsed.data as z.infer<S>;
}

/** Parse a body and hand it to a handler, for endpoints where the body is all it needs. */
export function withJson<S extends z.ZodType>(
  schema: S,
  handler: (request: Parameters<RouteHandler>[0], body: z.infer<S>) => Response | Promise<Response>,
): RouteHandler {
  return async (request) => await handler(request, await parseJson(request, schema));
}

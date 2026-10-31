import { createApiKey, listApiKeys, revokeApiKey } from "../handlers/auth-handlers";
import { output } from "../lib/output";
import { parseExpiresIn, parseScopeList } from "../lib/api-key-access";
import type { ApiKeyScope } from "@courier/shared";
import type { InsertApiKeyFn, ListApiKeysFn, DeleteApiKeyFn } from "../handlers/auth-handlers";

/**
 * Injectable actions for the apikey CLI commands.
 * Real implementations live in `apikey-actions.ts`; tests pass mocks so the
 * command layer can be exercised without a database.
 */
export interface ApikeyCliActions {
  insertApiKey: InsertApiKeyFn;
  listAll: ListApiKeysFn;
  deleteById: DeleteApiKeyFn;
  /** Existence check used by delete before mutating. */
  findApiKeyById: (id: string) => Promise<{ id: string } | undefined>;
}

export async function runApikeyList(json: boolean, actions: ApikeyCliActions): Promise<number> {
  const response = await listApiKeys(actions.listAll);
  if (json) {
    output(JSON.stringify(response.apiKeys));
    return 0;
  }
  if (response.apiKeys.length === 0) {
    output("No API keys found.");
    return 0;
  }
  output(["ID".padEnd(44), "Name".padEnd(24), "Scopes".padEnd(16), "Expires", "Created"].join(" "));
  output(
    ["─".repeat(44), "─".repeat(24), "─".repeat(16), "─".repeat(24), "─".repeat(24)].join(" "),
  );
  for (const k of response.apiKeys) {
    output(
      [
        k.id.padEnd(44),
        k.name.padEnd(24),
        (k.scopes.length > 0 ? k.scopes.join(",") : "-").padEnd(16),
        (k.expiresAt ?? "never").padEnd(24),
        k.createdAt,
      ].join(" "),
    );
  }
  return 0;
}

/** Options `apikey create` accepts. */
export interface ApikeyCreateOptions {
  /** Print the created key record as JSON instead of only the raw key. */
  json: boolean;
  /** `--expires-in` duration ("30m", "12h", "7d"); omitted = never expires. */
  expiresIn?: string;
  /** `--scopes` list ("status,users"); omitted = the full-power `admin`. */
  scopes?: string;
}

export async function runApikeyCreate(
  name: string,
  options: ApikeyCreateOptions,
  actions: ApikeyCliActions,
): Promise<number> {
  let scopes: ApiKeyScope[] | undefined;
  if (options.scopes !== undefined) {
    const parsed = parseScopeList(options.scopes);
    if (parsed === null) {
      console.error(`Error: unknown scope(s) in "${options.scopes}".`);
      return 1;
    }
    scopes = parsed;
  }

  let expiresAt: string | null = null;
  if (options.expiresIn !== undefined) {
    expiresAt = parseExpiresIn(options.expiresIn);
    if (expiresAt === null) {
      console.error(`Error: cannot read "${options.expiresIn}" as a duration (use 30m, 12h, 7d).`);
      return 1;
    }
  }

  const result = await createApiKey({ name, scopes, expiresAt }, actions.insertApiKey);
  // The full key is printed exactly once, whether as JSON or as the raw value.
  output(options.json ? JSON.stringify(result) : result.key);
  return 0;
}

export async function runApikeyDelete(id: string, actions: ApikeyCliActions): Promise<number> {
  const existing = await actions.findApiKeyById(id);
  if (!existing) {
    console.error(`Error: API key "${id}" not found.`);
    return 1;
  }
  await revokeApiKey(id, actions.deleteById);
  output(`API key "${id}" revoked.`);
  return 0;
}

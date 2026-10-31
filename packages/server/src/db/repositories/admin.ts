import { count, sql } from "drizzle-orm";
import { db } from "../../db";
import { fileVersions, users, vaults } from "../../db/schema";

/**
 * The counts the host-facing status read reports.
 *
 * They live here rather than in the route so that `routes/admin.ts` stays HTTP only —
 * the same split every other route follows, and one a lint rule can enforce.
 */

/** How many user accounts exist. */
export async function countUsers(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(users);
  return row.n;
}

/** How many vaults exist, across every account. */
export async function countVaults(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(vaults);
  return row.n;
}

/** Every vault id, for the admin storage walk. */
export async function listVaultIds(): Promise<string[]> {
  const rows = await db.select({ id: vaults.id }).from(vaults);
  return rows.map((row) => row.id);
}

/**
 * How many distinct device labels the version history has seen.
 *
 * There is no device registry any more: a client states its own label on every push, so
 * the nearest honest number is this — one machine that was renamed counts twice.
 */
export async function countDeviceNames(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${fileVersions.deviceName})` })
    .from(fileVersions);
  return row.n;
}

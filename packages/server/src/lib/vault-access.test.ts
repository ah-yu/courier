import { describe, expect, it } from "vitest";
import { canAccessVault } from "./vault-access";

/**
 * The one ownership rule, for every caller that has to ask it: the vault
 * management routes (`PATCH`/`DELETE /api/vaults/:id`) and, since the sync
 * surface was closed, `syncAuth` and the WebSocket `subscribe` handler.
 *
 * Kept here rather than in `vault-handlers.test.ts` because the rule is no
 * longer a handler's: `db/repositories/vaults.ts` writes the same rule as SQL for
 * a vault listing, and `vault-access.e2e.test.ts` pins the two together.
 */
describe("canAccessVault", () => {
  it("allows the owner", () => {
    expect(canAccessVault({ ownerUserId: "u-1" }, "u-1")).toBe(true);
  });

  it("allows any authenticated user for a legacy (owner-less) vault", () => {
    expect(canAccessVault({ ownerUserId: null }, "u-2")).toBe(true);
  });

  it("rejects a vault that belongs to someone else", () => {
    expect(canAccessVault({ ownerUserId: "u-1" }, "u-2")).toBe(false);
  });
});

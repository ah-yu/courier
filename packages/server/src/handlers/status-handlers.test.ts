import { describe, expect, it } from "vitest";
import { buildAdminStatus } from "./status-handlers";

/**
 * The status route is part of a contract a monitoring client reads
 * (`/api/admin/status`), so the fields it carries are asserted here rather than
 * discovered later in a UI that shows nothing.
 *
 * The **migration pair is part of it**: an operator has to be able to tell that the
 * database was migrated by a newer binary before it replaces anything. It arrives
 * from `db/migrations.ts`, whose chain is a plain array in the bundle — see
 * `migrations.generated.ts`.
 */
describe("buildAdminStatus", () => {
  it("passes every field through", () => {
    const status = buildAdminStatus({
      storageUsedBytes: 1024,
      storageLimitBytes: null,
      dbBytes: 4096,
      diskTotalBytes: 500_000,
      diskUsedBytes: 200_000,
      diskFreeBytes: 300_000,
      binarySha256: "a".repeat(64),
      binarySize: 1024,
      blobCount: 7,
      usersCount: 2,
      devicesCount: 3,
      vaultsCount: 1,
      migrationsApplied: 5,
      migrationsKnown: 6,
      version: "0.2.0",
    });

    expect(status).toEqual({
      storageUsedBytes: 1024,
      storageLimitBytes: null,
      dbBytes: 4096,
      diskTotalBytes: 500_000,
      diskUsedBytes: 200_000,
      diskFreeBytes: 300_000,
      binarySha256: "a".repeat(64),
      binarySize: 1024,
      blobCount: 7,
      usersCount: 2,
      devicesCount: 3,
      vaultsCount: 1,
      migrationsApplied: 5,
      migrationsKnown: 6,
      version: "0.2.0",
    });
  });

  it("names the build that answered and reports how far the database is ahead", () => {
    // A database migrated by a newer binary: more applied than this build knows.
    const status = buildAdminStatus({
      storageUsedBytes: 0,
      storageLimitBytes: 10,
      dbBytes: 0,
      diskTotalBytes: 0,
      diskUsedBytes: 0,
      diskFreeBytes: 0,
      binarySha256: "",
      binarySize: 0,
      blobCount: 0,
      usersCount: 0,
      devicesCount: 0,
      vaultsCount: 0,
      migrationsApplied: 7,
      migrationsKnown: 6,
      version: "dev",
    });

    expect(status.version).toBe("dev");
    expect(status.migrationsApplied).toBeGreaterThan(status.migrationsKnown);
  });
});

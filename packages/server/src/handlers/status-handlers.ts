import type { AdminStatusResponse } from "@courier/shared";

/**
 * Build the admin/service status snapshot. Pure function — the caller injects
 * the computed counts/bytes so it can be unit-tested without a DB.
 *
 * Everything here is a fact **the database or the filesystem owns**, which the
 * service process can therefore answer in-band. What the process cannot answer
 * about itself (whether it runs, why it stopped, its journal) stays on SSH.
 */
export function buildAdminStatus(input: {
  storageUsedBytes: number;
  storageLimitBytes: number | null;
  dbBytes: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
  diskFreeBytes: number;
  binarySha256: string;
  binarySize: number;
  blobCount: number;
  usersCount: number;
  devicesCount: number;
  vaultsCount: number;
  migrationsApplied: number;
  migrationsKnown: number;
  version: string;
}): AdminStatusResponse {
  return {
    storageUsedBytes: input.storageUsedBytes,
    storageLimitBytes: input.storageLimitBytes,
    dbBytes: input.dbBytes,
    diskTotalBytes: input.diskTotalBytes,
    diskUsedBytes: input.diskUsedBytes,
    diskFreeBytes: input.diskFreeBytes,
    binarySha256: input.binarySha256,
    binarySize: input.binarySize,
    blobCount: input.blobCount,
    usersCount: input.usersCount,
    devicesCount: input.devicesCount,
    vaultsCount: input.vaultsCount,
    migrationsApplied: input.migrationsApplied,
    migrationsKnown: input.migrationsKnown,
    version: input.version,
  };
}

import { listVaultIds } from "../db/repositories/admin";
import { listBlobHashes, sumBytes } from "./blob-store";
import type { StorageMeasurement } from "./storage-usage";

/**
 * The database and blob-store half of the admin storage reading.
 *
 * `storage-usage.ts` owns only the cache and takes this as an injected
 * `measure`, so importing the cache — as its unit test does — never opens
 * SQLite or walks the blob store. The admin route is the only caller.
 */
export async function measureStorageUsage(): Promise<StorageMeasurement> {
  const vaultIds = await listVaultIds();

  let bytes = 0;
  let blobs = 0;
  for (const vaultId of vaultIds) {
    bytes += await sumBytes(vaultId);
    blobs += (await listBlobHashes(vaultId)).length;
  }
  return { bytes, blobs, vaults: vaultIds.length };
}

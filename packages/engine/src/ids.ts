/** Generate a UUID for file identification. Assigned at file creation, never changes. */
export function generateFileId(): string {
  return crypto.randomUUID();
}

/**
 * Generate a UUID for a version event. Every edit gets a fresh versionId;
 * used to decide whether local/remote are on the same history point without
 * content-hash loops.
 */
export function generateVersionId(): string {
  return crypto.randomUUID();
}

import type { VersionChainEntry } from "@courier/shared";

/**
 * What the server holds, as far as this device knows: which path each live chain lives
 * at, what its head is, and which content hash belongs to which chain.
 *
 * The engine needs all three answers to keep **one path, one chain**:
 *
 * - a local event at a path the server already tracks must adopt that chain rather than
 *   fork a second one (`fileIdAt`);
 * - a push or a notification about a chain this device does not track locally must
 *   remember where it lives and what its head is, so the next event at that path is
 *   recognised (`remember`);
 * - a local file at a path no chain records — a rename whose notification was dropped —
 *   is matched to a chain by content, and only when that chain's previous path is gone
 *   (`fileIdForHash` plus the caller's own check).
 *
 * The reverse map (`fileIdToPath`) is not decoration: a pass asks "where does the server
 * think this chain lives?" once per fileId, and scanning the path map per file would make
 * a reconcile quadratic in vault size.
 *
 * It is rebuilt by every pass and kept current by every push and notification, which is
 * why it is a plain in-memory index with no persistence of its own: the state that has
 * to survive a restart is the sync points, not this view of the server.
 */
export class RemoteIndex {
  private readonly pathToFileId = new Map<string, string>();
  private readonly fileIdToPath = new Map<string, string>();
  private readonly fileIdToHead = new Map<string, VersionChainEntry>();
  private readonly hashToFileId = new Map<string, string>();
  /**
   * Every chain whose live head holds a given content hash.
   *
   * A hash-to-fileId lookup keeps one owner (the last chain recorded), but two files may
   * hold identical bytes. Without the full set, dropping the owner's hash — because that
   * chain moved or was forgotten — erased the lookup for the chain that still holds it,
   * and a later move of that second file forked a new chain. The set also makes that
   * drop O(1) while a rebuild of the index records each chain once.
   */
  private readonly hashToFileIds = new Map<string, Set<string>>();
  /**
   * The reverse of {@link hashToFileId}: the one hash a chain's head currently holds.
   *
   * Without it, `remember` had to scan the whole hash map to drop a chain's previous
   * hash — once per file while a pass rebuilds the index, i.e. O(N²) in vault size.
   */
  private readonly fileIdToHash = new Map<string, string>();

  /** How many live chains the index knows (diagnostics and tests). */
  get size(): number {
    return this.fileIdToPath.size;
  }

  /** Drop everything — the start of a pass that rebuilds it from the vault history. */
  clear(): void {
    this.pathToFileId.clear();
    this.fileIdToPath.clear();
    this.fileIdToHead.clear();
    this.hashToFileId.clear();
    this.hashToFileIds.clear();
    this.fileIdToHash.clear();
  }

  /** The fileId the server tracks at `path`, or null when it tracks none. */
  fileIdAt(path: string): string | null {
    return this.pathToFileId.get(path) ?? null;
  }

  /** The live path recorded for a chain, or null. */
  pathOf(fileId: string): string | null {
    return this.fileIdToPath.get(fileId) ?? null;
  }

  /** The live head recorded for a chain, or undefined when the index holds none. */
  headOf(fileId: string): VersionChainEntry | undefined {
    return this.fileIdToHead.get(fileId);
  }

  /** The fileId whose live head holds `hash`, or null. */
  fileIdForHash(hash: string): string | null {
    return this.hashToFileId.get(hash) ?? null;
  }

  /** Every live path the server knows (the pass's work list is built from these). */
  paths(): Iterable<string> {
    return this.pathToFileId.keys();
  }

  /** Every chain the index holds a live path for. */
  fileIds(): Iterable<string> {
    return this.fileIdToPath.keys();
  }

  /**
   * Record one chain's live identity.
   *
   * Whatever the same fileId was recorded under before is dropped: a chain has exactly
   * one live path and one head, and leaving the old pair behind is how a later event at
   * the old path would be read as a chain that still lives there.
   */
  remember(fileId: string, head: VersionChainEntry, path: string): void {
    this.forgetPrevious(fileId, path);
    const previousHash = this.fileIdToHash.get(fileId);
    if (previousHash !== undefined && previousHash !== head.contentHash) {
      this.dropHash(fileId, previousHash);
    }
    this.pathToFileId.set(path, fileId);
    this.fileIdToPath.set(fileId, path);
    this.fileIdToHead.set(fileId, head);
    this.fileIdToHash.set(fileId, head.contentHash);
    this.recordHash(fileId, head.contentHash);
  }

  /**
   * Drop one chain's identity.
   *
   * Called when a `delete` is applied: the chain still exists on the server (the recycle
   * bin reads it), but it holds no live path any more. Leaving its **previous** live head
   * in the index would make the next local file at that path adopt a chain whose content
   * the file does not have — i.e. turn "restore the parked copy" into a conflict against
   * the deletion that was just applied.
   */
  forget(fileId: string): void {
    const path = this.fileIdToPath.get(fileId);
    // Two chains can name one path for a moment; only remove the mapping while it is
    // still this chain's (see `forgetPrevious`).
    if (path !== undefined && this.pathToFileId.get(path) === fileId) {
      this.pathToFileId.delete(path);
    }
    const hash = this.fileIdToHash.get(fileId);
    if (hash !== undefined) this.dropHash(fileId, hash);
    this.fileIdToPath.delete(fileId);
    this.fileIdToHead.delete(fileId);
    this.fileIdToHash.delete(fileId);
  }

  /** Record that `fileId`'s head now holds `hash`, as the most recent owner. */
  private recordHash(fileId: string, hash: string): void {
    let owners = this.hashToFileIds.get(hash);
    if (owners === undefined) {
      owners = new Set();
      this.hashToFileIds.set(hash, owners);
    }
    // Re-adding an existing owner moves it to the end, so the set's last entry is the
    // most recently recorded chain — the one `fileIdForHash` answers with.
    owners.delete(fileId);
    owners.add(fileId);
    this.hashToFileId.set(hash, fileId);
  }

  /**
   * Drop `fileId`'s claim on `hash`, handing the lookup to another chain that still
   * holds the same content.
   *
   * The other chain must keep the mapping: a later local move of that file is matched by
   * content, and losing the mapping would fork a second chain for it.
   */
  private dropHash(fileId: string, hash: string): void {
    const owners = this.hashToFileIds.get(hash);
    if (owners === undefined) return;
    owners.delete(fileId);
    if (owners.size === 0) {
      this.hashToFileIds.delete(hash);
      if (this.hashToFileId.get(hash) === fileId) this.hashToFileId.delete(hash);
      return;
    }
    if (this.hashToFileId.get(hash) === fileId) {
      this.hashToFileId.set(hash, [...owners].at(-1)!);
    }
  }

  /** Drop the entries a chain is no longer at, keeping only `keepPath`. */
  private forgetPrevious(fileId: string, keepPath: string): void {
    const previousPath = this.fileIdToPath.get(fileId);
    // Two chains can name one path for a moment (a peer's move plus a new file at the
    // old path), and the other chain may have re-recorded it already. Only remove the
    // mapping while it still points at this chain.
    if (
      previousPath !== undefined &&
      previousPath !== keepPath &&
      this.pathToFileId.get(previousPath) === fileId
    ) {
      this.pathToFileId.delete(previousPath);
    }
  }
}

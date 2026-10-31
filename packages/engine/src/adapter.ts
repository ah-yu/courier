/**
 * What the engine needs to know about a file **without reading it**: how big it is
 * (the size cap) and when it last changed (the hash cache).
 */
export interface FileStamp {
  /** Plaintext size in bytes. */
  sizeBytes: number;
  /**
   * Last modification time, in milliseconds since the epoch.
   *
   * Used together with the size as a cheap "has this file changed at all?" test: a
   * pass that finds the same pair it recorded at the file's last sync point reuses
   * the hash it already has instead of reading and hashing the whole file again —
   * which for a vault of large attachments is the difference between a pass that
   * costs nothing and one that re-reads every byte in the vault.
   *
   * It is deliberately a **hint**: a file edited twice inside one filesystem
   * timestamp tick, ending at the same size, is missed until something else changes.
   * That is why every path that can afford to read still reads (a push, a conflict,
   * and any file whose stamp does not match the recorded one).
   */
  mtimeMs: number;
}

/**
 * A file being written a piece at a time.
 *
 * Returned by {@link SyncAdapter.beginWrite}. The engine uses it for a large
 * download so the plaintext never has to exist as one buffer: it decrypts a
 * chunk, hands it to {@link write}, and drops it before fetching the next one.
 *
 * The contract is what keeps the engine's "one write = one event = one hash"
 * invariant intact:
 *
 * - The target `path` is **not** visible while chunks arrive. The adapter writes
 *   to a temporary file inside the vault, so a watcher never reads a half-written
 *   file and no vault event fires per chunk.
 * - `close()` places the complete file at `path` in one step (a rename), so the
 *   target is either absent or complete.
 * - `abort()` discards the partial temporary file. It is called when a chunk
 *   fails to decrypt or the fetch fails, and must be safe after a failed `write`.
 */
export interface SyncWriteStream {
  /** Append the next piece. Chunks arrive in order. */
  write(chunk: Uint8Array): Promise<void>;

  /**
   * Commit: the target path now holds exactly the bytes written.
   *
   * An existing file at the target is replaced; the engine has already decided
   * this path is free or this chain's own.
   */
  close(): Promise<void>;

  /** Discard the partial file. A no-op when the write already closed. */
  abort(): Promise<void>;
}

/**
 * An incremental SHA-256 sink a host can provide for streamed downloads.
 *
 * The engine has a pure-TypeScript fallback; a host whose runtime offers a native
 * streaming hash (Bun's `CryptoHasher`, for the CLI) supplies it here so verifying a
 * large download does not pay the JavaScript compression cost. The digest must be the
 * standard SHA-256 hex form — the same value the engine's `sha256Hex` produces.
 */
export interface SyncHasher {
  update(chunk: Uint8Array): void;
  digestHex(): string;
}

/**
 * Filesystem abstraction the sync engine operates on. Hosts provide concrete
 * adapters: the Obsidian plugin wraps `Vault`, the headless CLI wraps `fs`.
 * All methods are async so both hosts work without structural changes.
 */
export interface SyncAdapter {
  /**
   * Every path this device could sync: markdown and canvas anywhere in the vault, the
   * file types the scope allows, plus the settings files its config-folder groups allow
   * (see `SyncScope`). Excludes `*.conflict.*` files upstream.
   *
   * This is "what exists", not "what syncs": the host prunes its walk with
   * `isSyncableDir` to keep it cheap, and the engine applies `isSyncablePath` to
   * the result regardless, so a candidate this listing over-reports is dropped
   * before it can be pushed.
   */
  listSyncableFiles(): Promise<string[]>;

  /** Read a file's raw bytes. Returns null when the file does not exist. */
  readFile(path: string): Promise<Uint8Array | null>;

  /**
   * The files living under the folders this device **excludes** from sync, or nothing
   * when the host cannot list them.
   *
   * This is a listing only — never a read — and the engine asks for it at most once
   * per burst, only when a tracked file has gone missing from a synced path. A move
   * into an excluded folder can reach a host as "removed here, created there" (an
   * external tool, the CLI's `fs.watch`, a plugin that was not running); the created
   * half is dropped by the scope, so without this listing the absence would be
   * published as a deletion of a file the user still owns. The engine narrows the
   * candidates by file name and only then reads one to compare the content hash.
   *
   * Optional: a host that omits it keeps the old behaviour, where such a move is
   * indistinguishable from a deletion.
   */
  listExcludedFiles?(): Promise<string[]>;

  /**
   * Size and modification time of a file, or null when it does not exist.
   *
   * The engine needs the size **before** reading: a file over `SyncScope.maxFileBytes`
   * is skipped rather than loaded into memory, which is what keeps a large video from
   * exhausting a phone during a hash. It needs the timestamp to skip work it has
   * already done — see {@link FileStamp}. Hosts answer both from their cheap metadata
   * (Obsidian's `TFile.stat` / `DataAdapter.stat`, Bun's `fs.stat`).
   */
  statFile(path: string): Promise<FileStamp | null>;

  /** Create or overwrite a file with raw bytes. */
  writeFile(path: string, bytes: Uint8Array): Promise<void>;

  /**
   * Start a streaming write that becomes visible only at {@link SyncWriteStream.close}.
   *
   * Optional: a host that cannot write a file in pieces omits it, and the engine
   * falls back to {@link writeFile} with the whole plaintext in memory. Hosts that
   * implement it — the CLI (`fs` handles) and the plugin (`DataAdapter` +
   * `rename`) — let a large download land without ever holding the file.
   *
   * Only called for versions the chunked-transfer rule already streams from the
   * network, so a note or a settings file still takes the ordinary path.
   */
  beginWrite?(path: string): Promise<SyncWriteStream>;

  /**
   * Incremental SHA-256 for a streamed download, or omitted to use the engine's
   * TypeScript fallback. The output must equal {@link sha256Hex} of the concatenated
   * chunks.
   */
  createHasher?(): SyncHasher;

  /** Delete a file. No-op when it does not exist. */
  deleteFile(path: string): Promise<void>;

  /** Rename/move a file. */
  renameFile(from: string, to: string): Promise<void>;
}

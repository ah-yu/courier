# Blob files: one flush per push batch

Status: **implemented**, 2026-10-30. Every push batch writes **one file** and flushes it
once; a file is immutable, and it is unlinked when its last row goes. There is no rotation,
no compaction and no recovery rule, because nothing is ever appended to after a batch ends.

**Question.** A 5 000-note first bind took 22 s to push, because `writePartsAtomic` fsynced
every blob. Can a batch be durable without paying a flush per file?

**Answer.** Yes, and it needs no more than one file per batch. `fsync` covers a file, so a
batch that writes its payloads into one file and flushes that file once gets the same
guarantee at 1/100 of the cost: the 5 000-file bind went from **22.1 s to 2.5 s** on APFS
(4.5 ms → 0.5 ms per file). The pull pays a little for it: on the same machine it went from
14.7 s to 16.7 s, for the reasons in
[first-bind-performance.md](first-bind-performance.md#2026-10-30-per-blob-fsync-removed-batch-writes-run-concurrently).

## The problem with a flush per blob

| Shape                                                | 5 000-file push | Durable?                                              |
| ---------------------------------------------------- | --------------: | ----------------------------------------------------- |
| one file per blob, `fsync` each (`writePartsAtomic`) |      **22.1 s** | yes                                                   |
| one file per blob, no `fsync`                        |           1.9 s | **no** — a committed row can point at unflushed bytes |
| **one file per batch, one `fsync`** (this design)    |       **2.5 s** | yes                                                   |

A file is the unit `fsync` and `rename` operate on, so "many blobs, one flush" needs a
container. The cheapest container is the batch itself: the store publishes its file first
and commits the blob rows in one transaction after it, and the push then commits its
version rows — a crash between those two commits leaves a file no row names, which the
sweep reclaims, never a row pointing at a half-written file.

## Layout

One table, no second entity to keep in step:

```sql
blobs(vault_id, content_hash, file, offset, length, plaintext_size, chunk_count, created_at)
  primary key (vault_id, content_hash), index (file)
```

- **Write path.** A batch opens `<uuid>.blob.tmp`, appends each framed blob at `offset`,
  `fsync`s the file, `rename`s it to `<uuid>.blob`, flushes the directory entry, and only
  then inserts the rows that name those ranges (in the store's own transaction, after which
  the push commits its version rows). A row that exists always means "these bytes are on
  disk under this name". The one exception is a batch that crosses 128 MiB while it is
  being written — a single request may carry more — which publishes mid-request and opens a
  fresh file, so one file holds at most that much plus the blob that crossed the line.
- **No recovery rule.** A `.tmp` that never got renamed is referenced by nothing. A file
  whose rows never committed is referenced by nothing. Both are garbage with no reader, so
  `sweepBlobFiles` deletes them once they are older than the TTL; there is no committed
  length to truncate to and no torn tail to reason about. Sweeping is not part of the write
  path: an unreferenced file is unreachable, not dangerous, and is collected on the same
  timer as the orphan sweep (and by the upload sweep, so `ORPHAN_SWEEP_INTERVAL_MS=0` does
  not leave it forever).
- **Reclaim is deletion, not rewriting.** `deleteBlob` removes the row and, in the same
  transaction, counts what still points into the file; when that count is zero it unlinks
  the file. Dead bytes never outlive the file, so they are bounded per file — one file's
  worth, up to the 128 MiB rotation point — and the space comes back when its last row goes.
- **Reads** do one indexed row lookup; the file's size is checked against the row before
  anything is served, so a lost or truncated file answers "absent" (`content_missing`)
  instead of a short body. A re-push **repoints** the row at the copy it writes
  (`ON CONFLICT DO UPDATE`), so a hash is never permanently unservable.
- **Chunked uploads** keep their staging directory (`uploads/<hash>/<n>.chunk`); assembly
  appends the assembled frame to a batch file and publishes it like any other.
- **Concurrency.** One batch per vault is open at a time, so appends are serialized by one
  promise chain. That is deliberate: the win is the amortized flush, and a second open file
  per vault would only add bookkeeping.

## What must stay true

- **One hash, one copy.** A blob row is keyed by the plaintext hash; a batch never rewrites
  bytes an earlier batch published, and dedupe is still a row lookup.
- **A chain never points at unreadable bytes.** `hasBlob` checks the row, the file's length
  on disk **and** that the frame parses; the content route answers 404, and a body too large
  to buffer is only streamed after the same length check.
- **The wire contract does not move.** `docs/api.md`'s content route, `Range`, `HEAD`, chunk
  staging and `status` keep their shapes; only the bytes behind them move.
- **The server holds no content semantics.** Blobs stay opaque bytes keyed by a
  client-supplied hash.
- **Cost stays bounded.** One flush per batch, one file per batch, and the sweep keeps the
  inode count proportional to the batches that still have live blobs.

## What was deliberately not built

The first draft of this change used append-only **segments** per vault (128 MiB, rotation,
compaction of dead bytes, a committed-length column and a truncate-on-open rule). That is
the design a multi-terabyte store needs; at the scale this product runs at — tens of
thousands of notes, one vault per user — it bought nothing the batch file does not, and it
cost a compaction subsystem, a recovery rule that could wedge a hash permanently, and two
extra index lookups on every content read. The batch file is the smallest container that
makes one flush cover a batch; everything above it was overhead.

## Test plan

- **L0** (`lib/blob-store.test.ts`): a batch is one file, the file is published before its
  rows, a file is unlinked only with its last row, a lost/truncated file reads as absent and
  a re-push heals it, a discarded batch publishes nothing, an unreferenced file and a
  `.tmp` are swept while a live one is not.
- **L1** (`packages/e2e`): push → pull byte equality, chunked upload and ranged pull, the
  benchmark invariants (`many`, `large`, `churn`).
- **L3**: unchanged — the store is server-only, but the suite pushes and pulls through it.

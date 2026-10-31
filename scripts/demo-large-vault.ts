#!/usr/bin/env bun
/**
 * Build a disposable vault big enough to watch a first sync.
 *
 * The first-bind work (progress, batching, the "first sync 12%" reading) is only
 * visible on a vault with thousands of files, and nobody wants to hand-write one. This
 * writes N small notes into a folder and prints what it did; point a new Obsidian vault
 * at that folder (or bind it with `courier-cli vault connect`) and connect it to a **new** remote
 * vault to see the whole first pass.
 *
 *   bun scripts/demo-large-vault.ts ./demo-vault 20000
 *
 * Files are markdown, 0.8–4 KiB, spread over 40 folders, so the sync sees a realistic
 * note vault rather than one flat directory.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";

const target = resolve(process.argv[2] ?? "./demo-vault");
const count = Number(process.argv[3] ?? "20000");

if (!Number.isSafeInteger(count) || count <= 0) {
  console.error(
    `usage: bun scripts/demo-large-vault.ts <folder> [files]  (files was "${process.argv[3]}")`,
  );
  process.exit(1);
}

mkdirSync(target, { recursive: true });

let bytes = 0;
const started = Date.now();
for (let index = 0; index < count; index++) {
  // Stable content per index: two runs produce the same vault (and the same hashes).
  const size = 800 + ((index * 2654435761) % 3200);
  const body = `# Note ${index}\n\n${String.fromCharCode(97 + (index % 26)).repeat(size)}\n`;
  const relative = `folder-${index % 40}/sub-${index % 11}/note-${index}.md`;
  const absolute = join(target, relative);
  mkdirSync(join(target, `folder-${index % 40}`, `sub-${index % 11}`), { recursive: true });
  writeFileSync(absolute, body);
  bytes += Buffer.byteLength(body);
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `wrote ${count} notes (${(bytes / 1024 / 1024).toFixed(1)} MiB) to ${target} in ${elapsed}s`,
);
console.log("");
console.log("Next, to watch a **first** sync (the counter only appears for a vault this");
console.log("device has never synced, so use a NEW remote vault):");
console.log("  plugin : add this folder as a vault in Obsidian, enable Courier, connect it");
console.log("           to a new remote vault, then hover the status-bar icon");
console.log("  headless: courier-cli vault connect --id <new vault> --path <this folder>;");
console.log("           `status` shows the first-sync counter (done / total)");
console.log("");
console.log("Headless (no UI), watch the daemon's own record while it binds:");
console.log(
  "  watch -n1 'cat ~/.courier-cli/runtime/*.json | grep -E \"phase|progress|firstSync\"'",
);

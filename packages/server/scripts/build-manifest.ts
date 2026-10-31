#!/usr/bin/env bun
/**
 * Generate the release manifest an installer reads to answer "is the
 * service on my server older than the published build?".
 *
 * An installer downloads this file (a few kilobytes) rather than the ~130 MB
 * binary: the manifest carries the `sha256` that identifies the build, so an
 * upgrade is recognised without transferring anything. The asset name and the
 * `<asset>.sha256` file beside it are the published convention (see
 * `docs/release.md`).
 *
 * The file is deliberately named `courier-server-manifest.json`, not
 * `manifest.json`: the same GitHub release also carries the Obsidian plugin,
 * whose manifest must keep that exact name.
 *
 * Usage:
 *   bun run --filter @courier/server manifest
 *   bun run --filter @courier/server manifest -- --asset courier-server-linux-x64 \
 *     --dir build --out build/courier-server-manifest.json --notes "first public release"
 */
import { readFileSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";

const packageDir = dirname(import.meta.dir);
/** Published beside the binary; see the header comment for why it is not `manifest.json`. */
const MANIFEST_NAME = "courier-server-manifest.json";

/** Parse `--key value` pairs; anything unknown is an error rather than silence. */
interface ManifestOptions {
  asset?: string;
  dir?: string;
  out?: string;
  notes?: string;
}

function parseArgs(argv: string[]): ManifestOptions {
  const known = new Set(["asset", "dir", "out", "notes"]);
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    // `bun run script -- args` passes the separator through on some shells
    // (and strips it on others); accept it as the conventional end-of-options
    // marker either way.
    if (key === "--") continue;
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const name = key.slice(2);
    if (!known.has(name)) throw new Error(`unknown option: ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`option ${key} needs a value`);
    }
    values[name] = value;
    i += 1;
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const asset = args.asset ?? "courier-server-linux-x64";
const dir = resolve(packageDir, args.dir ?? "build");
const binaryPath = join(dir, asset);
const outPath = resolve(packageDir, args.out ?? join(dir, MANIFEST_NAME));

const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8"));
const binary = readFileSync(binaryPath);

const manifest = {
  version: pkg.version,
  asset: basename(asset),
  sha256: new Bun.CryptoHasher("sha256").update(binary).digest("hex"),
  size: statSync(binaryPath).size,
  publishedAt: new Date().toISOString(),
  ...(args.notes ? { notes: args.notes } : {}),
};

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
// The checksum file the server verifies a download against, in the shape
// sha256sum writes, so `sha256sum -c` works on the server too.
writeFileSync(`${binaryPath}.sha256`, `${manifest.sha256}  ${basename(asset)}\n`);

console.log(`wrote ${outPath}`);
console.log(`wrote ${binaryPath}.sha256`);
console.log(
  `${manifest.asset} ${manifest.version} ${manifest.sha256.slice(0, 12)}… ${manifest.size} bytes`,
);

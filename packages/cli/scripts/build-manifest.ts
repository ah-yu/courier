#!/usr/bin/env bun
/**
 * Generate the release manifest an installer reads to install and upgrade the
 * headless CLI.
 *
 * The installer must know three things before replacing a binary: which asset belongs to
 * this machine, which checksum identifies it, and which version it is. The first two are
 * per platform, so unlike the server manifest (Linux x64 is the only deployment target)
 * this one carries an `assets` map keyed by the release's platform id.
 *
 * Usage:
 *   bun run --filter @courier/cli manifest
 *   bun run --filter @courier/cli manifest -- --dir build --out build/courier-cli-manifest.json \
 *     --notes "first public release"
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";

const packageDir = dirname(import.meta.dir);
/** Published beside the binaries; never `manifest.json`, which belongs to the plugin. */
const MANIFEST_NAME = "courier-cli-manifest.json";
const TARGETS = {
  "linux-x64": "courier-cli-linux-x64",
  "darwin-arm64": "courier-cli-darwin-arm64",
  "win-x64": "courier-cli-win-x64.exe",
};

/** Parse `--key value` pairs; anything unknown is an error rather than silence. */
interface ManifestOptions {
  dir?: string;
  out?: string;
  notes?: string;
}

function parseArgs(argv: string[]): ManifestOptions {
  const known = new Set(["dir", "out", "notes"]);
  const values: ManifestOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    // `bun run script -- args` passes the separator through on some shells and
    // strips it on others; accept it either way.
    if (key === "--") continue;
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const name = key.slice(2);
    if (!known.has(name)) throw new Error(`unknown option: ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`option ${key} needs a value`);
    }
    values[name as keyof ManifestOptions] = value;
    i += 1;
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const dir = resolve(packageDir, args.dir ?? "build");
const outPath = resolve(packageDir, args.out ?? join(dir, MANIFEST_NAME));
const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8"));

const assets = {};
for (const [platform, asset] of Object.entries(TARGETS)) {
  const binaryPath = join(dir, asset);
  if (!existsSync(binaryPath)) continue;
  const binary = readFileSync(binaryPath);
  const sha256 = new Bun.CryptoHasher("sha256").update(binary).digest("hex");
  assets[platform] = {
    asset: basename(asset),
    sha256,
    size: statSync(binaryPath).size,
  };
  // The same shape `sha256sum` writes, so a download can also be checked by hand.
  writeFileSync(`${binaryPath}.sha256`, `${sha256}  ${basename(asset)}\n`);
}

if (Object.keys(assets).length === 0) {
  throw new Error(`no CLI binaries found in ${dir}; run build:exe first`);
}

const manifest = {
  version: pkg.version,
  publishedAt: new Date().toISOString(),
  ...(args.notes ? { notes: args.notes } : {}),
  assets,
};

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${outPath}`);
for (const [platform, entry] of Object.entries(assets) as [
  string,
  { asset: string; sha256: string; size: number },
][]) {
  console.log(`${platform} ${entry.asset} ${entry.sha256.slice(0, 12)}… ${entry.size} bytes`);
}

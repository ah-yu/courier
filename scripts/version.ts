#!/usr/bin/env bun
/**
 * Stamp the three release packages with one snapshot version.
 *
 * A test build does not need a release tag, but the server, the CLI and the plugin
 * still have to agree on a version (`scripts/check-release.ts` enforces that): the
 * server reports it, the release manifest records it, and
 * the Obsidian plugin shows it. The snapshot form
 * `0.0.0-dev.YYYYMMDD.<shortsha>` says "not a release, built from this commit on
 * this day", which is what a test build is.
 *
 * The committed value is a snapshot too, so a fresh clone is buildable without
 * running this; run it before a test build to point the version at the current
 * commit. A release still bumps the three files to `X.Y.Z` by hand and tags it
 * (see `docs/release.md`).
 *
 * Usage:
 *   bun run version:snapshot              # 0.0.0-dev.<today, UTC>.<git short sha>
 *   bun run version:snapshot 0.0.0-dev.1  # an explicit value (must be 0.0.0-dev.*)
 */
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The three files a release keeps in step; see `scripts/check-release.ts`. */
const VERSION_FILES = [
  "packages/server/package.json",
  "packages/cli/package.json",
  "packages/plugin/manifest.json",
];

const SNAPSHOT = /^0\.0\.0-dev\.\d{8}\.[0-9A-Za-z]+$/;

/** The current commit, short, or the CI-provided revision when git is unavailable. */
function shortSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    const fromCi = process.env.GITHUB_SHA?.slice(0, 7);
    if (fromCi) return fromCi;
    throw new Error("cannot read the git revision: run this inside the repository");
  }
}

/** `0.0.0-dev.YYYYMMDD.<shortsha>`, with the date in UTC so a runner and a laptop agree. */
function snapshotVersion(sha: string): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `0.0.0-dev.${date}.${sha}`;
}

const explicit = process.argv[2];
const version = explicit ?? snapshotVersion(shortSha());

if (!SNAPSHOT.test(version)) {
  console.error(`[version] ${JSON.stringify(version)} is not 0.0.0-dev.YYYYMMDD.<shortsha>`);
  process.exit(1);
}

for (const relativePath of VERSION_FILES) {
  const path = join(root, relativePath);
  const document = JSON.parse(readFileSync(path, "utf8"));
  document.version = version;
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

console.log(version);

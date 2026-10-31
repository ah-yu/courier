#!/usr/bin/env bun
/**
 * Guard the release version before CI and before anything is built.
 *
 * One GitHub release ships `@courier/server`, `@courier/cli` and
 * `@courier/plugin` together under one `vX.Y.Z` tag, so all three versions must
 * agree with the tag. Without an argument the script only checks that the three
 * agree with each other; with a tag it also checks they equal that tag. This is
 * the release preflight and a plain CI step, so a version bump cannot land on
 * one package alone.
 *
 * Usage:
 *   bun scripts/check-release.ts            # the three versions agree
 *   bun scripts/check-release.ts v0.1.0     # the three versions equal the tag
 *
 * On success stdout carries only the version, so a workflow can capture it with
 * command substitution: `version=$(bun scripts/check-release.ts v0.1.0)`.
 */
import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FAILED_HEADER = "[release] FAILED";
const REQUIRED_PLUGIN_FIELDS = [
  "id",
  "name",
  "version",
  "minAppVersion",
  "description",
  "author",
  "authorUrl",
  "isDesktopOnly",
];

const failures = [];

/** Read and parse a JSON file, recording a failure instead of throwing. */
function readJson(relativePath) {
  try {
    return JSON.parse(readFileSync(join(root, relativePath), "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${relativePath}: ${message}`);
    return null;
  }
}

const tag = process.argv[2];
if (process.argv.length > 3) {
  failures.push("expected at most one argument: an optional vX.Y.Z tag");
}
if (tag !== undefined && !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  failures.push(`"${tag}" is not a release tag in the form vX.Y.Z`);
}

const server = readJson("packages/server/package.json");
const cli = readJson("packages/cli/package.json");
const plugin = readJson("packages/plugin/manifest.json");

const versions = [
  ["packages/server/package.json", server?.version],
  ["packages/cli/package.json", cli?.version],
  ["packages/plugin/manifest.json", plugin?.version],
];

/** Report a version that is missing or not semver, once per source. */
function checkVersion(source, version) {
  if (typeof version !== "string" || !SEMVER.test(version)) {
    failures.push(`${source}: version ${JSON.stringify(version)} is not semver`);
    return false;
  }
  return true;
}

const usable = versions.filter(([source, version]) => checkVersion(source, version));

if (plugin !== null) {
  for (const field of REQUIRED_PLUGIN_FIELDS) {
    if (!(field in plugin)) failures.push(`packages/plugin/manifest.json: missing "${field}"`);
  }
  if (typeof plugin.id === "string" && !/^[a-z0-9-]+$/.test(plugin.id)) {
    failures.push(
      `packages/plugin/manifest.json: id ${JSON.stringify(plugin.id)} is not lowercase letters, digits and hyphens`,
    );
  }
}

if (tag !== undefined) {
  const tagVersion = tag.slice(1);
  for (const [source, version] of usable) {
    if (version !== tagVersion) {
      failures.push(`${source}: version ${version} does not match tag ${tag} (${tagVersion})`);
    }
  }
} else if (usable.length > 0) {
  const [referenceSource, reference] = usable[0];
  for (const [source, version] of usable.slice(1)) {
    if (version !== reference) {
      failures.push(
        `${source}: version ${version} does not match ${referenceSource} (${reference})`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(FAILED_HEADER);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(server.version);

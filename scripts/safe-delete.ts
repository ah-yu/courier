#!/usr/bin/env bun
/**
 * Delete files, or a directory tree with --recursive, after proving each target
 * is strictly inside this checkout.
 *
 * This is the agent-facing cleanup path: it refuses symlinks, missing paths,
 * paths outside the current directory, the checkout root, the `.git` directory
 * and a root that is a filesystem root or the user's home. Recursion is only
 * available through --recursive, so a plain call still deletes exact files.
 *
 * Usage:
 *   bun scripts/safe-delete.ts <file> [<file> ...]
 *   bun scripts/safe-delete.ts --recursive <dir> [<dir> ...]
 *   bun scripts/safe-delete.ts --dry-run [--recursive] <target> [...]
 *
 * Run it from the checkout root. A relative path is resolved against the
 * current directory; an absolute path is accepted only when it is still inside
 * that directory.
 */
import { existsSync, lstatSync, realpathSync, rmSync, unlinkSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, parse, relative, resolve, sep } from "path";
import { pathToFileURL } from "url";

export class UnsafeDeleteError extends Error {
  name = "UnsafeDeleteError";
}

/** Filesystem paths compare case-insensitively on Windows. */
function comparable(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** True when path is a drive root or `/`. */
function isFilesystemRoot(path) {
  return parse(path).root === path;
}

/** True when target is strictly below root. */
function isInside(root, target) {
  const rel = relative(comparable(root), comparable(target));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Validate every target before anything is deleted.
 *
 * @param {string[]} rawPaths
 * @param {{cwd?: string, root?: string, recursive?: boolean}} [options]
 * @returns {{requested: string, path: string}[]}
 */
export interface SafeDeleteOptions {
  cwd?: string;
  root?: string;
  dryRun?: boolean;
  recursive?: boolean;
}

export function validateTargets(
  rawPaths: string[],
  options: SafeDeleteOptions = {},
): { requested: string; path: string }[] {
  const cwd = resolve(options.cwd ?? process.cwd());
  const root = resolve(options.root ?? cwd);
  if (rawPaths.length === 0) {
    throw new UnsafeDeleteError("no paths given");
  }
  if (isFilesystemRoot(root)) {
    throw new UnsafeDeleteError(`refusing to use a filesystem root as the boundary: ${root}`);
  }
  if (comparable(root) === comparable(resolve(homedir()))) {
    throw new UnsafeDeleteError(`refusing to use the home directory as the boundary: ${root}`);
  }

  const realRoot = realpathSync(root);
  const targets = rawPaths.map((raw) => {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new UnsafeDeleteError("empty path");
    }

    const absolute = resolve(cwd, raw);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      throw new UnsafeDeleteError(`does not exist: ${absolute}`);
    }
    if (stat.isSymbolicLink()) {
      throw new UnsafeDeleteError(`refusing a symlink: ${absolute}`);
    }
    if (stat.isDirectory() && !options.recursive) {
      throw new UnsafeDeleteError(`refusing a directory without --recursive: ${absolute}`);
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new UnsafeDeleteError(`refusing a non-regular file: ${absolute}`);
    }

    const real = realpathSync(absolute);
    if (comparable(real) === comparable(realRoot)) {
      throw new UnsafeDeleteError(`refusing the checkout root itself: ${real}`);
    }
    if (!isInside(realRoot, real)) {
      throw new UnsafeDeleteError(`outside the checkout ${realRoot}: ${real}`);
    }
    if (stat.isDirectory() && existsSync(join(real, ".git"))) {
      throw new UnsafeDeleteError(`refusing a Git worktree or repository root: ${real}`);
    }

    // Lower-case so a case-insensitive volume cannot smuggle `.GIT` past this.
    const rel = relative(realRoot, real).split(sep).join("/").toLowerCase();
    if (rel === ".git" || rel.startsWith(".git/")) {
      throw new UnsafeDeleteError(`refusing a path inside .git: ${rel}`);
    }
    return { requested: raw, path: real };
  });

  return targets;
}

/**
 * Validate all targets first, then delete them. Nothing is deleted when any
 * target is refused. A directory needs options.recursive.
 *
 * @param {string[]} rawPaths
 * @param {{cwd?: string, root?: string, dryRun?: boolean, recursive?: boolean}} [options]
 * @returns {{requested: string, path: string}[]}
 */
export function deleteFiles(
  rawPaths: string[],
  options: SafeDeleteOptions = {},
): { requested: string; path: string }[] {
  const targets = validateTargets(rawPaths, options);
  if (options.dryRun) {
    return targets;
  }
  for (const target of targets) {
    if (lstatSync(target.path).isDirectory()) {
      rmSync(target.path, { recursive: true, force: false });
    } else {
      unlinkSync(target.path);
    }
  }
  return targets;
}

function usage() {
  return [
    "Usage: bun scripts/safe-delete.ts [--dry-run] [--recursive] <target> [<target> ...]",
    "",
    "Deletes files, or directories with --recursive, strictly inside the current",
    "directory. Refuses symlinks, missing paths, the checkout root, .git contents,",
    "or paths outside the checkout.",
  ].join("\n");
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  for (const flag of flags) {
    if (flag !== "--dry-run" && flag !== "--recursive") {
      throw new UnsafeDeleteError(`unknown flag: ${flag}`);
    }
  }
  const paths = argv.filter((arg) => !arg.startsWith("--"));
  const dryRun = flags.has("--dry-run");
  const recursive = flags.has("--recursive");
  const targets = deleteFiles(paths, { dryRun, recursive });
  for (const target of targets) {
    console.log(`${dryRun ? "would delete" : "deleted"} ${target.path}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`safe-delete: ${error.message}`);
    process.exitCode = 1;
  }
}

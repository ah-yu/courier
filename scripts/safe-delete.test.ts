import assert from "assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join, parse } from "path";
import { afterEach, test } from "vitest";

import { deleteFiles, validateTargets } from "./safe-delete.ts";

/**
 * Cleanup registered by the running case. `bun:test` has no per-test `t.after`, so the
 * callbacks collect here and run after every test, newest first.
 */
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});

function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "courier-safe-delete-")));
  const files = [];
  const dirs = [];

  const dir = (name) => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    dirs.push(path);
    return path;
  };
  const file = (name, content = "x") => {
    const path = join(root, name);
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true });
    if (parent !== root) {
      dirs.push(parent);
    }
    writeFileSync(path, content);
    files.push(path);
    return path;
  };
  const clean = () => {
    for (const path of files.toReversed()) {
      try {
        unlinkSync(path);
      } catch {
        // Already deleted by the code under test.
      }
    }
    for (const path of dirs.toReversed()) {
      try {
        rmdirSync(path);
      } catch {
        // Not empty because a file inside it was already removed above;
        // rmdir non-recursive is deliberate.
      }
    }
    try {
      rmdirSync(root);
    } catch {
      // Best effort: a failed assertion should still leave the rest of the
      // checks runnable.
    }
  };

  return { root, dir, file, clean };
}

test("deletes exact files after validating all of them", () => {
  const s = scratch();
  cleanups.push(s.clean);
  const a = s.file("a.txt");
  const b = s.file("nested/b.txt");

  const targets = deleteFiles([a, b], { root: s.root });

  assert.deepEqual(
    targets.map((target) => target.path),
    [a, b],
  );
  assert.throws(() => validateTargets([a], { root: s.root }), /does not exist/);
});

test("refuses a directory without --recursive, a missing path and an empty list", () => {
  const s = scratch();
  cleanups.push(s.clean);
  const directory = s.dir("a-directory");

  assert.throws(() => validateTargets([directory], { root: s.root }), /without --recursive/);
  assert.throws(
    () => validateTargets([s.root], { root: s.root, recursive: true }),
    /checkout root/,
  );
  assert.throws(
    () => validateTargets([join(s.root, "missing")], { root: s.root }),
    /does not exist/,
  );
  assert.throws(() => validateTargets([], { root: s.root }), /no paths given/);
});

test("--recursive removes a directory tree inside the checkout", () => {
  const s = scratch();
  cleanups.push(s.clean);
  const directory = s.dir("tree");
  s.file("tree/nested/a.txt");
  s.file("tree/b.txt");

  deleteFiles([directory], { root: s.root, recursive: true });

  assert.throws(() => validateTargets([directory], { root: s.root }), /does not exist/);
});

test("refuses a directory that is a Git worktree root", () => {
  const s = scratch();
  cleanups.push(s.clean);
  const repo = s.dir("repo");
  s.file("repo/.git", "gitdir: elsewhere");

  assert.throws(
    () => validateTargets([repo], { root: s.root, recursive: true }),
    /Git worktree or repository root/,
  );
});

test("refuses a recursive target outside the checkout", () => {
  const s = scratch();
  const outside = scratch();
  cleanups.push(s.clean);
  cleanups.push(outside.clean);
  const directory = outside.dir("outside-tree");
  outside.file("outside-tree/a.txt");

  assert.throws(
    () => validateTargets([directory], { root: s.root, recursive: true }),
    /outside the checkout/,
  );
});

test("refuses a path outside the checkout", () => {
  const s = scratch();
  const outside = scratch();
  cleanups.push(s.clean);
  cleanups.push(outside.clean);
  const file = outside.file("outside.txt");

  assert.throws(() => validateTargets([file], { root: s.root }), /outside the checkout/);
});

test("refuses a path inside .git", () => {
  const s = scratch();
  cleanups.push(s.clean);
  const file = s.file(".git/config");

  assert.throws(() => validateTargets([file], { root: s.root }), /inside \.git/);
});

test("refuses a symlink", () => {
  const s = scratch();
  cleanups.push(s.clean);
  const target = s.file("target.txt");
  const link = join(s.root, "link.txt");
  try {
    symlinkSync(target, link);
  } catch {
    // Windows without Developer Mode refuses symlinks, so there is nothing to assert.
    console.log("skip: symlinks are not available to this user");
    return;
  }
  cleanups.push(() => {
    try {
      unlinkSync(link);
    } catch {
      // Already gone.
    }
  });

  assert.throws(() => validateTargets([link], { root: s.root }), /symlink/);
});

test("refuses a filesystem root or the home directory as the boundary", () => {
  const s = scratch();
  cleanups.push(s.clean);
  const file = s.file("a.txt");

  assert.throws(() => validateTargets([file], { root: parse(s.root).root }), /filesystem root/);
  assert.throws(() => validateTargets([file], { root: homedir() }), /home directory/);
});

test("--dry-run validates but does not delete", () => {
  const s = scratch();
  cleanups.push(s.clean);
  const file = s.file("a.txt");

  const targets = deleteFiles([file], { root: s.root, dryRun: true });

  assert.equal(targets.length, 1);
  assert.doesNotThrow(() => validateTargets([file], { root: s.root }));
});

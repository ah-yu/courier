/**
 * Turn a package's entry point into the release binaries.
 *
 * `bun build --compile` embeds the Bun runtime and the bundled entry point in one
 * executable per target, so a release asset is "download one file and run it" with no
 * runtime to install on the host. The three targets, the asset naming and the build
 * identity (`COURIER_VERSION`, `COURIER_GIT_SHA`, `COURIER_BUILD_TIME`) and
 * `COURIER_ENV=production` defines are the same for every binary this repository ships,
 * so they live here rather than in each package: the packages differ only in their entry
 * point and asset prefix, and those are passed in.
 *
 * This package is build tooling. It is private and never imported by shipped code, which
 * is why the two packages that compile binaries (`@courier/cli`, `@courier/server`) list
 * it as a `devDependencies` entry and call it from their own `scripts/build-exe.ts`.
 */

import { execFileSync } from "child_process";
import { mkdirSync, readFileSync } from "fs";
import { join, resolve } from "path";

/** One binary-producing package. */
export interface ExecutableSpec {
  /** Absolute path of the package: its `package.json` supplies the version, `build/` receives the assets. */
  packageDir: string;
  /** Entry point, relative to `packageDir`. */
  entry: string;
  /** Release asset prefix: the asset is `<prefix>-<suffix><ext>`. */
  prefix: string;
}

/**
 * Release asset names are the published convention (`docs/release.md`): `suffix` is
 * the platform in the asset name, `target` the Bun target, `ext` what the platform
 * expects.
 */
const TARGETS = [
  { target: "bun-linux-x64", suffix: "linux-x64", ext: "" },
  { target: "bun-darwin-arm64", suffix: "darwin-arm64", ext: "" },
  { target: "bun-windows-x64", suffix: "win-x64", ext: ".exe" },
];

/**
 * Compile every target into `<packageDir>/build/`.
 *
 * Cross-compiling downloads the target's Bun runtime on first use; Bun caches it under
 * the repository's `.bun-cache/`.
 */
export async function buildExecutables(spec: ExecutableSpec): Promise<void> {
  const { packageDir, entry, prefix } = spec;
  // A workspace package sits at `<repo>/packages/<name>`; `git` has to run at the root.
  const repoRoot = resolve(packageDir, "..", "..");
  const outDir = join(packageDir, "build");
  mkdirSync(outDir, { recursive: true });

  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8")) as {
    version?: string;
  };
  const gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf-8",
  }).trim();

  /** Values `--define` replaces at build time; JSON quoting is part of the value. */
  const defines = {
    "process.env.COURIER_ENV": "production",
    "process.env.COURIER_VERSION": pkg.version ?? "dev",
    "process.env.COURIER_GIT_SHA": gitSha,
    "process.env.COURIER_BUILD_TIME": new Date().toISOString(),
  };

  for (const { target, suffix, ext } of TARGETS) {
    const outfile = join(outDir, `${prefix}-${suffix}${ext}`);
    console.log(`[build-exe] ${prefix} ${target} -> ${outfile}`);
    const proc = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        `--target=${target}`,
        "--minify",
        ...Object.entries(defines).flatMap(([key, value]) => [
          "--define",
          `${key}=${JSON.stringify(value)}`,
        ]),
        "--outfile",
        outfile,
        join(packageDir, entry),
      ],
      { cwd: repoRoot, stdout: "inherit", stderr: "inherit" },
    );
    const code = await proc.exited;
    if (code !== 0) {
      // Throwing instead of exiting: this is a library function, and the caller owns the
      // process (the package entry script runs at top level, so Bun still exits non-zero).
      throw new Error(`[build-exe] ${target} failed with exit code ${code}`);
    }
  }
}

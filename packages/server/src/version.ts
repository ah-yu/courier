/**
 * The build's identity, injected into the bundle at build time.
 *
 * `bun build`'s `--define` performs a compile-time replacement of
 * `process.env.KEY`, which is how `COURIER_ENV` is already baked into this package
 * (the built bundle contains no `process.env.COURIER_ENV` at all). The same
 * mechanism carries the version, so the compiled binary can report what it is
 * without reading a file next to itself or reaching the network.
 *
 * A development run (`bun src/main.ts`) and a plain `tsc` build perform no
 * replacement, so every value falls back to something honest rather than
 * `undefined`.
 */

/** Version of this build, from packages/server/package.json. */
export const VERSION: string = process.env.COURIER_VERSION ?? "dev";

/** Short git revision the build came from, or "" when it was not known. */
export const GIT_SHA: string = process.env.COURIER_GIT_SHA ?? "";

/** When the build was made, RFC 3339 in UTC, or "" when it was not known. */
export const BUILD_TIME: string = process.env.COURIER_BUILD_TIME ?? "";

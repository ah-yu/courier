#!/usr/bin/env bun
/**
 * Mirror a GitHub release's assets to a CNB (cnb.cool) release.
 *
 * GitHub is the only build. This script runs after `release.yml` has published a
 * GitHub release: it uploads the same files, byte for byte, to a CNB release so
 * users whose GitHub downloads are slow can fetch the identical binaries,
 * manifests and checksums from cnb.cool.
 *
 * CNB has no `releases/latest/download` alias. Its download route is
 * `/{repo}/-/releases/download/{tag}/{asset}`, and the tag must exist. The
 * release workflow pushes the version tag; for the release GitHub reports as the
 * latest stable one, this script also maintains a `latest` alias release (its
 * tag is created once by CNB and is a download channel, not a source ref).
 *
 * Usage:
 *   bun scripts/cnb-mirror.ts --repo ah-yu/courier --tag v0.1.0 \
 *     --target-sha <sha> --assets ./cnb-assets --body-file notes.md \
 *     [--source-url https://github.com/.../releases/tag/v0.1.0] \
 *     [--make-latest] [--latest-tag latest] [--dry-run]
 *
 * Environment:
 *   CNB_TOKEN          access token with repo-code:rw and repo-release:rw
 *   CNB_API_ENDPOINT   default https://api.cnb.cool
 *   CNB_WEB_ENDPOINT   default https://cnb.cool
 *
 * `--dry-run` needs no token and makes no network call; it prints the asset list
 * and the release plan, for a local check before a real run.
 */
import { createHash } from "crypto";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

const DEFAULT_API = "https://api.cnb.cool";
const DEFAULT_WEB = "https://cnb.cool";
const RETRIES = 3;
const VERIFY_POLLS = 5;
const API_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

export interface MirrorAsset {
  name: string;
  path: string;
  size: number;
  sha256: string;
}

export interface CnbReleaseAsset {
  id?: string;
  name: string;
  size: number;
  hash_algo?: string;
  hash_value?: string;
  /** API download URL, usable while the release is still a draft. */
  url?: string;
}

export interface CnbRelease {
  id: string;
  tag_name: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  is_latest?: boolean;
  tag_commitish?: string;
  assets?: CnbReleaseAsset[];
}

interface AssetUploadTarget {
  upload_url: string;
  verify_url: string;
  expires_in_sec?: number;
}

interface ReleaseSpec {
  tag: string;
  targetSha: string;
  name: string;
  body: string;
  prerelease: boolean;
  makeLatest: "true" | "false";
  draft: boolean;
}

export interface MirrorDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

/** The subset of `fetch` the mirror needs; a plain function is enough in tests. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface MirrorOptions {
  repo: string;
  tag: string;
  targetSha: string;
  assetsDir: string;
  body?: string;
  sourceUrl?: string;
  latestTag?: string;
  baseUrl?: string;
  webUrl?: string;
  token?: string;
  dryRun?: boolean;
  /**
   * Mark this release as CNB's latest. The workflow sets it only when GitHub
   * reports the tag as the latest stable release, so re-running an old release
   * cannot move the `latest` channel backwards.
   */
  makeLatest?: boolean;
  deps?: MirrorDeps;
}

export interface MirrorResult {
  tag: string;
  prerelease: boolean;
  uploaded: number;
  skipped: number;
  alias?: { tag: string; uploaded: number; skipped: number };
  dryRun: boolean;
}

interface MirrorContext {
  repo: string;
  base: string;
  web: string;
  token: string;
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

export class CnbApiError extends Error {
  status: number;
  path: string;
  detail: string;

  constructor(status: number, path: string, detail: string) {
    super(`CNB API ${status} ${path}: ${detail}`);
    this.name = "CnbApiError";
    this.status = status;
    this.path = path;
    this.detail = detail;
  }
}

/** A tag with a hyphen after the version is a prerelease, exactly as `release.yml` treats it. */
export function isPrerelease(tag: string): boolean {
  return tag.replace(/^v/, "").includes("-");
}

/** Hash a file without loading it into memory whole (the binaries are ~100 MiB each). */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** Every regular, non-hidden file in the directory, with its size and SHA-256. */
export async function describeAssets(dir: string): Promise<MirrorAsset[]> {
  const root = resolve(dir);
  const entries = readdirSync(root, { withFileTypes: true });
  const assets: MirrorAsset[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (!entry.isFile()) {
      throw new Error(`asset directory contains a non-file entry: ${entry.name}`);
    }
    const size = statSync(path).size;
    if (size === 0) throw new Error(`asset is empty: ${entry.name}`);
    assets.push({ name: entry.name, path, size, sha256: await sha256File(path) });
  }
  assets.sort((left, right) => left.name.localeCompare(right.name));
  if (assets.length === 0) throw new Error(`no assets found in ${root}`);
  return assets;
}

/**
 * Assets to upload and assets the release already holds unchanged.
 *
 * An upload is skipped only when the remote release reports the same name,
 * size and SHA-256; a remote hash in another algorithm is not trusted, so that
 * asset is uploaded again rather than assumed equal.
 */
export function planUploads(
  assets: MirrorAsset[],
  existing: CnbReleaseAsset[] = [],
): { upload: MirrorAsset[]; skip: MirrorAsset[] } {
  const byName = new Map(existing.map((asset) => [asset.name, asset]));
  const upload: MirrorAsset[] = [];
  const skip: MirrorAsset[] = [];
  for (const asset of assets) {
    const remote = byName.get(asset.name);
    const same =
      remote !== undefined &&
      remote.size === asset.size &&
      remote.hash_algo?.toLowerCase() === "sha256" &&
      remote.hash_value?.toLowerCase() === asset.sha256;
    (same ? skip : upload).push(asset);
  }
  return { upload, skip };
}

/** The release notes: the GitHub body plus the mirror's provenance footer. */
export function buildReleaseBody(body: string, tag: string, sourceUrl?: string): string {
  const trimmed = body.trim();
  const lines: string[] = [];
  if (trimmed) lines.push(trimmed, "");
  lines.push("---", "");
  lines.push(
    sourceUrl
      ? `Mirrored from the GitHub release [${tag}](${sourceUrl}).`
      : `Mirrored from the GitHub release ${tag}.`,
  );
  lines.push("The files are byte-identical to the GitHub assets.");
  lines.push("Verify a binary with `sha256sum -c checksums.txt`.");
  return `${lines.join("\n")}\n`;
}

/** The moving `latest` release points at the current stable version. */
export function buildAliasBody(tag: string, sourceUrl?: string): string {
  const link = sourceUrl ? `[${tag}](${sourceUrl})` : tag;
  return [
    `Latest stable Courier build, mirrored from GitHub release ${link}.`,
    "",
    "The assets are byte-identical to that release and are replaced on each stable release.",
    "Verify a binary with `sha256sum -c checksums.txt`.",
    "",
  ].join("\n");
}

export interface CliOptions {
  repo: string;
  tag: string;
  targetSha: string;
  assetsDir: string;
  bodyFile?: string;
  sourceUrl?: string;
  latestTag?: string;
  baseUrl?: string;
  webUrl?: string;
  makeLatest?: boolean;
  dryRun: boolean;
  help: boolean;
}

const VALUE_FLAGS = new Set([
  "repo",
  "tag",
  "target-sha",
  "assets",
  "body-file",
  "source-url",
  "latest-tag",
  "base-url",
  "web-url",
]);

export function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  let dryRun = false;
  let help = false;
  let makeLatest: boolean | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--make-latest") {
      makeLatest = true;
      continue;
    }
    if (arg === "--no-make-latest") {
      makeLatest = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const equals = arg.indexOf("=");
    const key = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    if (!VALUE_FLAGS.has(key)) throw new Error(`unknown flag: --${key}`);
    if (values.has(key)) throw new Error(`duplicate flag: --${key}`);
    const value = equals === -1 ? argv[++index] : arg.slice(equals + 1);
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new Error(`--${key} needs a value`);
    }
    values.set(key, value);
  }

  if (help) {
    return {
      repo: "",
      tag: "",
      targetSha: "",
      assetsDir: "",
      makeLatest,
      dryRun,
      help: true,
    };
  }

  for (const required of ["repo", "tag", "target-sha", "assets"]) {
    if (!values.has(required)) throw new Error(`missing --${required}`);
  }

  return {
    repo: values.get("repo")!,
    tag: values.get("tag")!.replace(/^refs\/tags\//, ""),
    targetSha: values.get("target-sha")!,
    assetsDir: resolve(values.get("assets")!),
    bodyFile: values.get("body-file"),
    sourceUrl: values.get("source-url"),
    latestTag: values.get("latest-tag"),
    baseUrl: values.get("base-url"),
    webUrl: values.get("web-url"),
    makeLatest,
    dryRun,
    help: false,
  };
}

function normalizeRepo(repo: string): string {
  const normalized = repo
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "");
  if (normalized.includes("://") || !normalized.includes("/")) {
    throw new Error(`--repo must look like <group>/<repo>, got ${JSON.stringify(repo)}`);
  }
  return normalized;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function createContext(options: MirrorOptions): MirrorContext {
  return {
    repo: normalizeRepo(options.repo),
    base: trimTrailingSlash(options.baseUrl ?? process.env.CNB_API_ENDPOINT ?? DEFAULT_API),
    web: trimTrailingSlash(options.webUrl ?? process.env.CNB_WEB_ENDPOINT ?? DEFAULT_WEB),
    token: options.token ?? process.env.CNB_TOKEN ?? "",
    fetch: options.deps?.fetch ?? fetch,
    sleep:
      options.deps?.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms))),
    log: options.deps?.log ?? ((message: string) => console.log(message)),
  };
}

function releasePath(repo: string, suffix = ""): string {
  return `/${repo}/-/releases${suffix}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeError(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "(empty body)";
  try {
    const parsed = JSON.parse(trimmed);
    const detail = parsed.errmsg ?? parsed.message ?? parsed.error;
    if (typeof detail === "string" && detail !== "") return detail.slice(0, 500);
  } catch {
    // Not JSON; fall through to the raw body.
  }
  return trimmed.slice(0, 500);
}

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
  return 500 * 2 ** attempt;
}

async function fetchWithRetry(
  ctx: MirrorContext,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const response = await ctx.fetch(url, {
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
        ...init,
      });
      if ((response.status === 429 || response.status >= 500) && attempt < RETRIES - 1) {
        await ctx.sleep(retryDelay(response, attempt));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt === RETRIES - 1) break;
      await ctx.sleep(500 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`request failed: ${url}`);
}

async function api<T>(
  ctx: MirrorContext,
  path: string,
  init: RequestInit = {},
): Promise<T | undefined> {
  const headers = new Headers({
    Authorization: `Bearer ${ctx.token}`,
    Accept: "application/vnd.cnb.api+json",
  });
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (init.headers !== undefined) {
    for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  }
  const response = await fetchWithRetry(ctx, `${ctx.base}${path}`, { ...init, headers });
  const text = await response.text();
  if (!response.ok) throw new CnbApiError(response.status, path, describeError(text));
  if (text.trim() === "") return undefined;
  return JSON.parse(text) as T;
}

async function getReleaseByTag(ctx: MirrorContext, tag: string): Promise<CnbRelease | undefined> {
  try {
    return await api<CnbRelease>(ctx, releasePath(ctx.repo, `/tags/${encodeURIComponent(tag)}`));
  } catch (error) {
    if (error instanceof CnbApiError && error.status === 404) return undefined;
    throw error;
  }
}

/** A release is looked up by id after creation: a draft may not have its tag yet. */
async function getReleaseById(ctx: MirrorContext, id: string): Promise<CnbRelease | undefined> {
  try {
    return await api<CnbRelease>(ctx, releasePath(ctx.repo, `/${id}`));
  } catch (error) {
    if (error instanceof CnbApiError && error.status === 404) return undefined;
    throw error;
  }
}

async function createRelease(ctx: MirrorContext, spec: ReleaseSpec): Promise<CnbRelease> {
  const release = await api<CnbRelease>(ctx, releasePath(ctx.repo), {
    method: "POST",
    body: JSON.stringify({
      tag_name: spec.tag,
      target_commitish: spec.targetSha,
      name: spec.name,
      body: spec.body,
      draft: spec.draft,
      prerelease: spec.prerelease,
      make_latest: spec.makeLatest,
    }),
  });
  if (release === undefined || release.id === undefined) {
    throw new Error(`CNB did not return a release id for ${spec.tag}`);
  }
  return release;
}

async function patchRelease(
  ctx: MirrorContext,
  release: CnbRelease,
  spec: ReleaseSpec,
): Promise<void> {
  await api(ctx, releasePath(ctx.repo, `/${release.id}`), {
    method: "PATCH",
    body: JSON.stringify({
      name: spec.name,
      body: spec.body,
      draft: spec.draft,
      prerelease: spec.prerelease,
      make_latest: spec.makeLatest,
    }),
  });
}

/** Publish a release prepared as a draft, and only then expose it. */
async function publishRelease(
  ctx: MirrorContext,
  release: CnbRelease,
  spec: ReleaseSpec,
): Promise<void> {
  await api(ctx, releasePath(ctx.repo, `/${release.id}`), {
    method: "PATCH",
    body: JSON.stringify({
      name: spec.name,
      body: spec.body,
      draft: false,
      prerelease: spec.prerelease,
      make_latest: spec.makeLatest,
    }),
  });
}

async function ensureRelease(
  ctx: MirrorContext,
  spec: ReleaseSpec,
  existing?: CnbRelease,
): Promise<CnbRelease> {
  const current = existing ?? (await getReleaseByTag(ctx, spec.tag));
  if (current !== undefined) {
    // A published version release stays visible during a re-run; the alias is
    // deliberately re-drafted while its assets change, so a reader never sees a
    // new manifest beside an old binary.
    await patchRelease(ctx, current, spec);
    return { ...current, ...spec, draft: spec.draft };
  }

  try {
    return await createRelease(ctx, spec);
  } catch (error) {
    // Another run may have created it between the lookup and the create.
    if (error instanceof CnbApiError && (error.status === 409 || error.status === 422)) {
      const raced = await getReleaseByTag(ctx, spec.tag);
      if (raced !== undefined) {
        await patchRelease(ctx, raced, spec);
        return { ...raced, ...spec, draft: spec.draft };
      }
    }
    throw error;
  }
}

async function uploadAsset(
  ctx: MirrorContext,
  releaseId: string,
  asset: MirrorAsset,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const target = await api<AssetUploadTarget>(
        ctx,
        releasePath(ctx.repo, `/${releaseId}/asset-upload-url`),
        {
          method: "POST",
          body: JSON.stringify({
            asset_name: asset.name,
            size: asset.size,
            overwrite: true,
            ttl: 0,
          }),
        },
      );
      if (target === undefined || !target.upload_url || !target.verify_url) {
        throw new Error("CNB did not return an upload URL");
      }

      const put = await ctx.fetch(target.upload_url, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: Bun.file(asset.path),
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (!put.ok) {
        throw new Error(`upload PUT ${put.status}: ${describeError(await put.text())}`);
      }

      const verifyUrl = target.verify_url.startsWith("http")
        ? target.verify_url
        : `${ctx.base}${target.verify_url}`;
      const verify = new URL(verifyUrl);
      const headers: Record<string, string> = { Accept: "application/vnd.cnb.api+json" };
      // A pre-signed confirmation URL may live on another host; never send the
      // release-scoped token to an origin the API did not name.
      if (verify.origin === new URL(ctx.base).origin) {
        headers.Authorization = `Bearer ${ctx.token}`;
      }
      const confirm = await ctx.fetch(verify, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!confirm.ok) {
        throw new Error(
          `upload confirmation ${confirm.status}: ${describeError(await confirm.text())}`,
        );
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < RETRIES - 1) {
        ctx.log(`[cnb-mirror] retrying ${asset.name}: ${errorMessage(error)}`);
        await ctx.sleep(1000 * 2 ** attempt);
      }
    }
  }
  throw new Error(`could not upload ${asset.name}: ${errorMessage(lastError)}`);
}

function remoteSha256(release: CnbRelease, name: string): string | undefined {
  const remote = release.assets?.find((asset) => asset.name === name);
  if (remote === undefined || remote.hash_algo?.toLowerCase() !== "sha256") return undefined;
  return remote.hash_value?.toLowerCase();
}

function publicUrl(ctx: MirrorContext, tag: string, name: string): string {
  return `${ctx.web}/${ctx.repo}/-/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

async function downloadSha256(
  ctx: MirrorContext,
  url: string,
  name: string,
  authenticated: boolean,
): Promise<string> {
  const headers: Record<string, string> = {};
  if (authenticated) headers.Authorization = `Bearer ${ctx.token}`;
  const response = await ctx.fetch(url, {
    headers,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`cannot verify ${name}: download returned ${response.status}`);
  }
  if (response.body === null) throw new Error(`cannot verify ${name}: download has no body`);
  const hash = createHash("sha256");
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyRelease(
  ctx: MirrorContext,
  release: CnbRelease,
  assets: MirrorAsset[],
): Promise<CnbRelease> {
  let current = (await getReleaseById(ctx, release.id)) ?? release;

  // The API computes the asset hash after the upload confirmation; give it a
  // moment rather than treating a just-confirmed asset as unverifiable.
  for (let poll = 0; poll < VERIFY_POLLS; poll++) {
    if (assets.every((asset) => remoteSha256(current, asset.name) !== undefined)) break;
    await ctx.sleep(1000);
    const fresh = await getReleaseById(ctx, release.id);
    if (fresh === undefined) throw new Error(`CNB release ${release.id} disappeared after upload`);
    current = fresh;
  }

  for (const asset of assets) {
    const remote = current.assets?.find((candidate) => candidate.name === asset.name);
    if (remote === undefined) {
      throw new Error(`CNB release ${release.tag_name} is missing asset ${asset.name}`);
    }
    if (remote.size !== asset.size) {
      throw new Error(`CNB asset ${asset.name} is ${remote.size} bytes, expected ${asset.size}`);
    }

    const hash = remoteSha256(current, asset.name);
    if (hash !== undefined) {
      if (hash !== asset.sha256) {
        throw new Error(`CNB asset ${asset.name} has sha256 ${hash}, expected ${asset.sha256}`);
      }
      continue;
    }

    // The API normally returns the hash. If it does not, prove the bytes by
    // downloading the asset and hashing it; a missing hash is never success.
    // The API download URL normally works for a draft release too; the public
    // route is the fallback when the API does not return one.
    const downloadUrl = remote.url ?? publicUrl(ctx, release.tag_name, asset.name);
    const authenticated =
      remote.url !== undefined && new URL(downloadUrl).origin === new URL(ctx.base).origin;
    const downloaded = await downloadSha256(ctx, downloadUrl, asset.name, authenticated);
    if (downloaded !== asset.sha256) {
      throw new Error(
        `CNB asset ${asset.name} has sha256 ${downloaded} at download, expected ${asset.sha256}`,
      );
    }
  }
  return current;
}

/**
 * The `latest` release is a moving channel: its assets are replaced on every
 * stable release. A versioned file name (the plugin zip) would otherwise stay
 * behind, so remove the previous plugin zips; every other asset name is stable
 * and is overwritten in place. A failure to prune is a warning, not a failed
 * mirror, because the current assets are already uploaded and verified.
 */
async function pruneAliasAssets(
  ctx: MirrorContext,
  release: CnbRelease,
  keep: Set<string>,
): Promise<void> {
  for (const asset of release.assets ?? []) {
    if (keep.has(asset.name)) continue;
    if (!/^courier-plugin-.*\.zip$/.test(asset.name)) continue;
    if (asset.id === undefined) {
      ctx.log(`[cnb-mirror] warning: cannot remove stale alias asset ${asset.name} (no id)`);
      continue;
    }
    try {
      await api(ctx, releasePath(ctx.repo, `/${release.id}/assets/${asset.id}`), {
        method: "DELETE",
      });
      ctx.log(`[cnb-mirror] removed stale alias asset ${asset.name}`);
    } catch (error) {
      ctx.log(
        `[cnb-mirror] warning: could not remove stale alias asset ${asset.name}: ${errorMessage(error)}`,
      );
    }
  }
}

export async function mirror(options: MirrorOptions): Promise<MirrorResult> {
  const ctx = createContext(options);
  const prerelease = isPrerelease(options.tag);
  if (options.dryRun !== true && ctx.token === "") {
    throw new Error("CNB_TOKEN is not set (or pass --dry-run)");
  }
  const assets = await describeAssets(options.assetsDir);
  const makeLatest = !prerelease && (options.makeLatest ?? true);
  const latestTag =
    options.latestTag !== undefined &&
    options.latestTag !== "" &&
    makeLatest &&
    options.latestTag !== options.tag
      ? options.latestTag
      : undefined;

  if (options.dryRun === true) {
    ctx.log(
      `[cnb-mirror] dry run: ${ctx.repo} ${options.tag} (${assets.length} assets, prerelease=${prerelease}, makeLatest=${makeLatest})`,
    );
    for (const asset of assets) {
      ctx.log(`  ${asset.name} ${asset.size} bytes sha256=${asset.sha256}`);
    }
    if (latestTag !== undefined) ctx.log(`  would also mirror ${latestTag}`);
    return {
      tag: options.tag,
      prerelease,
      uploaded: 0,
      skipped: 0,
      dryRun: true,
    };
  }

  const existingVersion = await getReleaseByTag(ctx, options.tag);
  const versionSpec: ReleaseSpec = {
    tag: options.tag,
    targetSha: options.targetSha,
    name: `Courier ${options.tag}`,
    body: buildReleaseBody(options.body ?? "", options.tag, options.sourceUrl),
    prerelease,
    // A draft is not yet "latest"; the publish step sets the final flag.
    makeLatest: "false",
    // A new release is hidden until every asset has been uploaded and verified.
    // A re-run of an already published version keeps it visible.
    draft: existingVersion === undefined || existingVersion.draft === true,
  };
  const version = await ensureRelease(ctx, versionSpec, existingVersion);

  const versionPlan = planUploads(assets, version.assets ?? []);
  for (const asset of versionPlan.upload) {
    ctx.log(`[cnb-mirror] uploading ${asset.name} to ${options.tag}`);
    await uploadAsset(ctx, version.id, asset);
  }
  await verifyRelease(ctx, version, assets);
  await publishRelease(ctx, version, {
    ...versionSpec,
    draft: false,
    makeLatest: makeLatest ? "true" : "false",
  });
  ctx.log(
    `[cnb-mirror] ${options.tag}: ${versionPlan.upload.length} uploaded, ${versionPlan.skip.length} unchanged`,
  );

  let alias: MirrorResult["alias"];
  if (latestTag !== undefined) {
    const existingAlias = await getReleaseByTag(ctx, latestTag);
    const aliasSpec: ReleaseSpec = {
      tag: latestTag,
      targetSha: options.targetSha,
      name: `Courier latest (${options.tag})`,
      body: buildAliasBody(options.tag, options.sourceUrl),
      prerelease: false,
      makeLatest: "false",
      // Hide the channel while its assets are replaced; a reader must never see
      // a new manifest beside an old binary.
      draft: true,
    };
    const aliasRelease = await ensureRelease(ctx, aliasSpec, existingAlias);
    const aliasPlan = planUploads(assets, aliasRelease.assets ?? []);
    for (const asset of aliasPlan.upload) {
      ctx.log(`[cnb-mirror] uploading ${asset.name} to ${latestTag}`);
      await uploadAsset(ctx, aliasRelease.id, asset);
    }
    const aliasVerified = await verifyRelease(ctx, aliasRelease, assets);
    await publishRelease(ctx, aliasRelease, { ...aliasSpec, draft: false });
    await pruneAliasAssets(ctx, aliasVerified, new Set(assets.map((asset) => asset.name)));
    alias = {
      tag: latestTag,
      uploaded: aliasPlan.upload.length,
      skipped: aliasPlan.skip.length,
    };
    ctx.log(`[cnb-mirror] ${latestTag}: ${alias.uploaded} uploaded, ${alias.skipped} unchanged`);
  }

  return {
    tag: options.tag,
    prerelease,
    uploaded: versionPlan.upload.length,
    skipped: versionPlan.skip.length,
    alias,
    dryRun: false,
  };
}

function usage(): string {
  return [
    "Usage: bun scripts/cnb-mirror.ts --repo <group/repo> --tag <tag>",
    "         --target-sha <sha> --assets <dir> [options]",
    "",
    "Uploads a GitHub release's assets to the matching CNB release.",
    "",
    "Options:",
    "  --body-file <path>    GitHub release notes to use as the CNB body",
    "  --source-url <url>    GitHub release URL for the provenance footer",
    "  --make-latest         mark this release as CNB's latest (the default for",
    "                        a stable tag; pass --no-make-latest when re-running",
    "                        an older release)",
    "  --latest-tag <tag>    update this alias release too (only with --make-latest)",
    "  --base-url <url>      CNB API base (default $CNB_API_ENDPOINT or https://api.cnb.cool)",
    "  --web-url <url>       CNB web base (default $CNB_WEB_ENDPOINT or https://cnb.cool)",
    "  --dry-run             print the plan; no token, no network",
    "  --help                show this text",
    "",
    "Environment:",
    "  CNB_TOKEN             access token with repo-code:rw and repo-release:rw",
  ].join("\n");
}

async function main(argv: string[]): Promise<void> {
  const cli = parseArgs(argv);
  if (cli.help) {
    console.log(usage());
    return;
  }
  const body = cli.bodyFile === undefined ? "" : readFileSync(resolve(cli.bodyFile), "utf8");
  const result = await mirror({
    repo: cli.repo,
    tag: cli.tag,
    targetSha: cli.targetSha,
    assetsDir: cli.assetsDir,
    body,
    sourceUrl: cli.sourceUrl,
    latestTag: cli.latestTag,
    baseUrl: cli.baseUrl,
    webUrl: cli.webUrl,
    makeLatest: cli.makeLatest,
    dryRun: cli.dryRun,
  });
  if (result.dryRun) {
    console.log("[cnb-mirror] dry run only; nothing was uploaded");
    return;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[cnb-mirror] FAILED: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}

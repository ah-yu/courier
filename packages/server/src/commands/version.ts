import { runtimeLabel } from "@courier/shared";
import { BUILD_TIME, GIT_SHA, VERSION } from "../version";
import { output } from "../lib/output";

/**
 * What a binary can say about itself: where it came from, nothing about the
 * database it is pointed at.
 *
 * An update check compares this against a release manifest,
 * so the shape is part of the contract (`docs/cli.md`). The **migration counts**
 * deliberately live in `GET /api/admin/status` instead of here: they only mean
 * something next to the database that has applied them, and reading them costs a
 * database open — this command stays free of the migration list, which also
 * keeps it importable from a plain test run.
 */
export interface VersionInfo {
  version: string;
  gitSha: string;
  buildTime: string;
  /** The runtime the binary embeds (`bun/<version>`), so a bug report can name it. */
  runtime: string;
}

/** Build the version report from the injected constants. */
export function buildVersionInfo(overrides: Partial<VersionInfo> = {}): VersionInfo {
  return {
    version: VERSION,
    gitSha: GIT_SHA,
    buildTime: BUILD_TIME,
    runtime: runtimeLabel(process.versions),
    ...overrides,
  };
}

/**
 * `courier version [--json]` — print what this binary is.
 *
 * It exists for the operator: "is the deployed build the one I just published?"
 * is answered by the checksum, and "how far behind am I?" by the version. A
 * binary whose version is `dev` was not produced by the release build, which is
 * reported as an unlabelled build rather than pretending to compare
 * versions.
 */
export async function runVersion(json: boolean): Promise<number> {
  const info = buildVersionInfo();

  if (json) {
    output(JSON.stringify(info));
    return 0;
  }

  output(`Courier server ${info.version}`);
  if (info.gitSha) output(`Revision: ${info.gitSha}`);
  if (info.buildTime) output(`Built: ${info.buildTime}`);
  output(`Runtime: ${info.runtime}`);
  return 0;
}

import { describe, expect, it } from "vitest";
import { sortedCopy } from "@courier/shared";
import { buildVersionInfo } from "./version";

/**
 * The version report is what an update check compares against a release
 * manifest, so its shape is a contract (`docs/cli.md`) and not just diagnostics.
 */
describe("buildVersionInfo", () => {
  it("reports the injected identity", () => {
    const info = buildVersionInfo({
      version: "1.2.3",
      gitSha: "abc1234",
      buildTime: "2026-06-11T09:00:00.000Z",
    });

    expect(info.version).toBe("1.2.3");
    expect(info.gitSha).toBe("abc1234");
    expect(info.buildTime).toBe("2026-06-11T09:00:00.000Z");
    expect(info.runtime).toMatch(/^bun\/\d+\.\d+\.\d+/);
  });

  it("reports the build's own defaults when nothing replaced the constants", () => {
    const info = buildVersionInfo();
    expect(typeof info.version).toBe("string");
    expect(info.version.length).toBeGreaterThan(0);
  });

  it("carries no database facts", () => {
    // The migration counts live in `GET /api/admin/status`, next to the database
    // that has applied them; this report must not grow a second copy.
    expect(sortedCopy(Object.keys(buildVersionInfo()))).toEqual([
      "buildTime",
      "gitSha",
      "runtime",
      "version",
    ]);
  });
});

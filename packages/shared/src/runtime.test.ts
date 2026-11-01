import { describe, expect, it } from "vitest";
import { runtimeLabel } from "./runtime";

/**
 * `runtimeLabel` is read by `version --json` and by `/api/admin/runtime`, so the
 * three answers — Bun, the plugin's Electron, and a process that reports nothing —
 * are pinned here rather than left to whichever host happens to run the suite.
 *
 * The versions bag is passed in, so these cases need no global `process` at all.
 */
describe("runtimeLabel", () => {
  it("names Bun through versions.bun, not the compatibility version", () => {
    expect(runtimeLabel({ bun: "1.4.4", node: "22.6.0" })).toBe("bun/1.4.4");
  });

  it("names the plugin's Electron runtime", () => {
    expect(runtimeLabel({ electron: "30.0.0", node: "20.15.0" })).toBe("electron/30.0.0");
  });

  it("answers unknown when the process reports no versions at all", () => {
    expect(runtimeLabel(undefined)).toBe("unknown");
  });

  it("answers unknown when the versions object is empty", () => {
    expect(runtimeLabel({})).toBe("unknown");
  });
});

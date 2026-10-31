import { afterEach, describe, expect, it } from "vitest";
import { runtimeLabel } from "./runtime";

/** The global `process`, kept so each case can put the real one back. */
const original = globalThis.process;

/** Replace the global `process` the helper reads, the way a host would see it. */
function stubProcess(versions: Record<string, string> | undefined): void {
  globalThis.process = { versions } as unknown as typeof process;
}

/**
 * `runtimeLabel` is read by `version --json` and by `/api/admin/runtime`, so the
 * three answers — Bun, the plugin's Electron, and a process that reports nothing —
 * are pinned here rather than left to whichever host happens to run the suite.
 */
describe("runtimeLabel", () => {
  afterEach(() => {
    globalThis.process = original;
  });

  it("names Bun through versions.bun, not the compatibility version", () => {
    stubProcess({ bun: "1.4.4", node: "22.6.0" });
    expect(runtimeLabel()).toBe("bun/1.4.4");
  });

  it("names the plugin's Electron runtime", () => {
    stubProcess({ electron: "30.0.0", node: "20.15.0" });
    expect(runtimeLabel()).toBe("electron/30.0.0");
  });

  it("answers unknown when the process reports no versions at all", () => {
    stubProcess(undefined);
    expect(runtimeLabel()).toBe("unknown");
  });

  it("answers unknown when the versions object is empty", () => {
    stubProcess({});
    expect(runtimeLabel()).toBe("unknown");
  });
});

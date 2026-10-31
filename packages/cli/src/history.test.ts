import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SyncActivityEvent } from "@courier/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityLogPath, clearActivityLog, recordRunActivity } from "./history";

/**
 * The daemon's run history is a supervisor's source for "what did this run sync": one JSON
 * line per engine event, cleared when a run starts, with the vault id hashed into the name
 * so a server-chosen id cannot escape the directory.
 */
describe("run history", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "courier-history-test-"));
    process.env.COURIER_CLI_CONFIG_DIR = dir;
  });

  afterEach(() => {
    delete process.env.COURIER_CLI_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("records each event as one line under a hashed name", () => {
    recordRunActivity("vault/../escape", {
      direction: "out",
      fileId: "file-1",
      versionId: "version-1",
      plainPath: "notes/a.md",
      action: "modify",
      sizeBytes: 12,
      deviceName: null,
      outcome: "applied",
    });
    const path = activityLogPath("vault/../escape");
    expect(path.startsWith(dir)).toBe(true);
    expect(path).not.toContain("..");
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.plainPath).toBe("notes/a.md");
    expect(entry.outcome).toBe("applied");
    expect(typeof entry.at).toBe("string");
  });

  it("start a new run by clearing what the previous one wrote", () => {
    recordRunActivity("vault-a", {
      direction: "in",
      fileId: null,
      versionId: null,
      plainPath: "video/big.mov",
      action: null,
      sizeBytes: 99,
      deviceName: "NAS",
      outcome: "skipped",
      reason: "size",
    });
    expect(readFileSync(activityLogPath("vault-a"), "utf-8")).toContain("big.mov");
    clearActivityLog("vault-a");
    expect(() => readFileSync(activityLogPath("vault-a"), "utf-8")).toThrow();
  });

  // A reconcile re-reports decisions it already sent; the plugin's log records each
  // version once, so the file a supervisor reads must too.
  it("records a repeated decision once", () => {
    clearActivityLog("vault-dedupe");
    const event = {
      direction: "out",
      fileId: "file-1",
      versionId: "version-1",
      plainPath: "notes/a.md",
      action: "modify",
      sizeBytes: 10,
      deviceName: null,
      outcome: "applied",
    } satisfies SyncActivityEvent;
    recordRunActivity("vault-dedupe", event);
    recordRunActivity("vault-dedupe", event);
    const path = activityLogPath("vault-dedupe");
    expect(readFileSync(path, "utf-8").trim().split("\n")).toHaveLength(1);
    recordRunActivity("vault-dedupe", { ...event, versionId: "version-2" });
    expect(readFileSync(path, "utf-8").trim().split("\n")).toHaveLength(2);
  });
});

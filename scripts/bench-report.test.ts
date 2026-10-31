/**
 * Tests for `bench-report.ts`, the renderer that turns benchmark runs into the
 * pull-request comment. The script is a CLI, so every case goes through it the
 * way the workflow does: two folders in, Markdown and an exit code out.
 */
import assert from "assert/strict";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { test } from "vitest";
import { fileURLToPath } from "url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "bench-report.ts");
const scratch = mkdtempSync(join(tmpdir(), "courier-bench-report-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

let caseNumber = 0;

/** A fresh pair of folders for one test, so runs from different cases never mix. */
function dirs() {
  caseNumber++;
  const root = join(scratch, String(caseNumber));
  const base = join(root, "base");
  const head = join(root, "head");
  mkdirSync(base, { recursive: true });
  mkdirSync(head, { recursive: true });
  return { root, base, head };
}

/** Write one benchmark result file. */
function writeRun(dir, name, result) {
  writeFileSync(join(dir, name), `${JSON.stringify(result, null, 2)}\n`);
}

/** A minimal result; `phases` is `[label, ms]` pairs. */
function run(scenario, phases, extra = {}) {
  return {
    scenario,
    runId: "1",
    ok: true,
    phases: phases.map(([label, ms]) => ({ label, ms })),
    ...extra,
  };
}

/** Run the CLI and capture its verdict without throwing on a non-zero exit. */
function report(args) {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [SCRIPT, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    return {
      status: typeof error.status === "number" ? error.status : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

test("renders the marker, a phase table and the delta", () => {
  const { base, head } = dirs();
  writeRun(base, "many-1.json", run("many", [["A first bind", 1000]]));
  writeRun(head, "many-1.json", run("many", [["A first bind", 1200]]));

  const result = report(["--base", base, "--head", head]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /<!-- courier-bench-summary -->/);
  assert.match(result.stdout, /### many/);
  assert.match(result.stdout, /\| A first bind \| 1,000 ms \| 1,200 ms \| \+20% \|/);
  assert.match(
    result.stdout,
    /Correctness: base no invariant reported · PR no invariant reported\./,
  );
});

test("reports the median, not the mean or the last run", () => {
  const { base, head } = dirs();
  writeRun(base, "run-1.json", run("many", [["bind", 3000]]));
  writeRun(base, "run-2.json", run("many", [["bind", 1000]]));
  writeRun(base, "run-3.json", run("many", [["bind", 2000]]));
  writeRun(head, "run-1.json", run("many", [["bind", 2000]]));

  const result = report(["--base", base, "--head", head]);

  assert.equal(result.status, 0);
  // The three base runs span 1000–3000 ms, so the ⚠ (a spread over 20%) is part
  // of the contract: the median is right, the side is noisy.
  assert.match(result.stdout, /\| bind \| 2,000 ms \| 2,000 ms \| 0% ⚠ \|/);
  assert.match(result.stdout, /Runs: 3 base, 1 PR/);
});

test("a false invariant fails the render even when the timing is better", () => {
  const { base, head } = dirs();
  writeRun(
    base,
    "many-1.json",
    run("many", [["bind", 1000]], {
      checks: { transfer: { bytesEqual: true } },
    }),
  );
  writeRun(
    head,
    "many-1.json",
    run("many", [["bind", 900]], {
      checks: { transfer: { bytesEqual: false } },
    }),
  );

  const result = report(["--base", base, "--head", head]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Correctness check failed:\*\* many: PR: transfer\.bytesEqual/);
  assert.match(result.stdout, /base 1\/1 invariants held · PR 0\/1 invariants held/);
});

test("a crashed run is a failure, not a missing sample", () => {
  const { base, head } = dirs();
  writeRun(base, "many-1.json", run("many", [["bind", 1000]]));
  writeRun(head, "many-1.json", { ...run("many", [["bind", 800]]), ok: false });

  const result = report(["--base", base, "--head", head]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Correctness check failed:\*\* many: PR: run reported ok=false/);
});

test("a boolean fact is not an invariant", () => {
  const { base, head } = dirs();
  writeRun(
    base,
    "many-1.json",
    run("many", [["bind", 1000]], {
      checks: { server: { blob: { uploadsDir: false } } },
    }),
  );
  writeRun(
    head,
    "many-1.json",
    run("many", [["bind", 1000]], {
      checks: { server: { blob: { uploadsDir: true } } },
    }),
  );

  const result = report(["--base", base, "--head", head]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /no invariant reported/);
  assert.doesNotMatch(result.stdout, /Correctness check failed/);
});

test("checks.invariants is the explicit contract", () => {
  const { base, head } = dirs();
  writeRun(
    base,
    "many-1.json",
    run("many", [["bind", 1000]], { checks: { invariants: { landed: true } } }),
  );
  writeRun(
    head,
    "many-1.json",
    run("many", [["bind", 1000]], { checks: { invariants: { landed: false } } }),
  );

  const result = report(["--base", base, "--head", head]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Correctness check failed:\*\* many: PR: invariants\.landed/);
});

test("without --base it renders absolute medians and no delta", () => {
  const { head } = dirs();
  writeRun(
    head,
    "many-1.json",
    run("many", [["bind", 1200]], { checks: { invariants: { ok: true } } }),
  );
  writeRun(
    head,
    "many-2.json",
    run("many", [["bind", 1000]], { checks: { invariants: { ok: true } } }),
  );

  const result = report(["--head", head]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /\| Phase \| Median \|/);
  assert.match(result.stdout, /\| bind \| 1,100 ms \|/);
  assert.doesNotMatch(result.stdout, /Δ/);
  assert.match(result.stdout, /single-side run/);
  assert.match(result.stdout, /2\/2 invariants held/);
});

test("--fail-over without a baseline is a usage error", () => {
  const { head } = dirs();
  writeRun(head, "many-1.json", run("many", [["bind", 1000]]));

  assert.equal(report(["--head", head, "--fail-over", "25"]).status, 2);
});

test("--fail-over turns a large regression into exit 1, and leaves noise alone", () => {
  const { base, head } = dirs();
  writeRun(base, "many-1.json", run("many", [["bind", 1000]]));
  writeRun(head, "many-1.json", run("many", [["bind", 1300]]));

  assert.equal(report(["--base", base, "--head", head]).status, 0);
  const gated = report(["--base", base, "--head", head, "--fail-over", "25"]);

  assert.equal(gated.status, 1);
  assert.match(gated.stdout, /Slower than the 25% threshold/);
});

test("a scenario only on the head side is a note, not an error", () => {
  const { base, head } = dirs();
  writeRun(base, "many-1.json", run("many", [["bind", 1000]]));
  writeRun(head, "many-1.json", run("many", [["bind", 1000]]));
  writeRun(head, "large-1.json", run("large", [["push", 9000]]));

  const result = report(["--base", base, "--head", head]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /New scenario in this pull request/);
  assert.match(result.stdout, /### large/);
});

test("a renamed phase shows a dash for the side that does not have it", () => {
  const { base, head } = dirs();
  writeRun(base, "many-1.json", run("many", [["old label", 1000]]));
  writeRun(head, "many-1.json", run("many", [["new label", 900]]));

  const result = report(["--base", base, "--head", head]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /\| old label \| 1,000 ms \| — \| — \|/);
  assert.match(result.stdout, /\| new label \| — \| 900 ms \| — \|/);
});

test("--out writes the comment to a file", () => {
  const { root, base, head } = dirs();
  writeRun(base, "many-1.json", run("many", [["bind", 1000]]));
  writeRun(head, "many-1.json", run("many", [["bind", 1000]]));
  const out = join(root, "comment.md");

  const result = report(["--base", base, "--head", head, "--out", out]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(readFileSync(out, "utf8"), /<!-- courier-bench-summary -->/);
});

test("missing folders and malformed results are usage errors", () => {
  const { base, head, root } = dirs();
  writeRun(base, "many-1.json", run("many", [["bind", 1000]]));
  writeRun(head, "not-a-result.json", { hello: "world" });

  assert.equal(report(["--base", join(root, "missing"), "--head", head]).status, 2);
  assert.equal(report([]).status, 2);
  assert.equal(report(["--base", base, "--head", head, "--fail-over", "not-a-number"]).status, 2);
  assert.equal(report(["--base", base, "--head", head]).status, 2);
});

#!/usr/bin/env bun
/**
 * Turn per-run benchmark JSON files into the comment that goes on a pull request.
 *
 * This is the reporting half of the CI benchmark design (see
 * `docs/ci-sync-benchmarks.md`). The bench job runs each scenario several times
 * against the merge base and several times against the pull request, writes one
 * JSON file per run, and uploads them. This script reads the two folders, takes
 * the median of every phase on each side, and renders a sticky Markdown comment.
 *
 * A "result" is one measured process:
 *
 *   {
 *     "scenario": "many",
 *     "runId": "1",
 *     "ok": true,
 *     "system": { "cpu": "...", "platform": "linux", "runtime": "bun/1.4.4" },
 *     "phases": [{ "label": "A first bind", "ms": 16110.5 }],
 *     "checks": { "initialTransfer": { "bytesEqual": true } }
 *   }
 *
 * The shape is the one the existing perf harness already writes into
 * `.perf/results/` (an untracked, throwaway directory); the fields this script
 * needs are `scenario`, `phases[].label` and `phases[].ms`. `checks` is optional.
 * A CI runner should write `checks.invariants` as `{ "name": boolean }`; every
 * one of those must be true. For the current harness, whose `checks` also carry
 * facts such as `server.blob.uploadsDir`, a boolean counts as an invariant only
 * when its key says so (`*Equal`, `*Match`, `*Sequential`, `every…`), because a
 * fast run that lost files is a regression, not an improvement.
 *
 * Usage:
 *
 *   bun scripts/bench-report.ts --base .bench/base --head .bench/head \
 *     --out bench-comment.md [--fail-over 25] [--run-url <actions run url>]
 *
 * `--base` is optional: without it the comment is an absolute single-side run,
 * which is what `workflow_dispatch` produces. `--fail-over` is a soft gate: with
 * it, any phase slower than that percentage makes the script exit 1 (the workflow
 * decides whether that fails the job). No threshold means the comment is
 * informational.
 *
 * Exit codes: 0 rendered, 1 a correctness check failed or `--fail-over` was
 * exceeded, 2 usage/input error.
 */
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { extname, join, resolve } from "path";

const MARKER = "<!-- courier-bench-summary -->";
/** A delta smaller than this is treated as runner noise, not a regression. */
const NOISE_PERCENT = 10;
/** A phase whose own runs spread by more than this gets the "unreliable" mark. */
const UNRELIABLE_SPREAD_PERCENT = 20;
const integer = new Intl.NumberFormat("en-US");

/** Print usage and exit with the conventional "bad input" code. */
function usage(message) {
  if (message) console.error(`bench-report: ${message}`);
  console.error(
    "usage: bun scripts/bench-report.ts --base <dir> --head <dir> [--out <file>] " +
      "[--fail-over <percent>] [--run-url <url>]",
  );
  process.exit(2);
}

/** Read `--name value` pairs; every option this script has takes a value. */
interface BenchReportOptions {
  head?: string;
  base?: string;
  out?: string;
  "run-url"?: string;
  "fail-over"?: string;
}

function parseArgs(argv: string[]): BenchReportOptions {
  const options: BenchReportOptions = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!flag.startsWith("--")) usage(`unexpected argument ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) usage(`${flag} needs a value`);
    options[flag.slice(2) as keyof BenchReportOptions] = value;
    index++;
  }
  return options;
}

/** The median of a non-empty numeric array. */
function median(values) {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Round to `digits` places, as a number (so `toLocaleString` works). */
function round(value, digits = 1) {
  return Number(value.toFixed(digits));
}

/** `+12.3%` / `-4.0%`; a positive number means the pull request is slower. */
function percent(delta) {
  const sign = delta > 0 ? "+" : "";
  return `${sign}${round(delta, 1)}%`;
}

/** Milliseconds, grouped so a five-digit number stays readable in a table. */
function milliseconds(value) {
  return `${integer.format(round(value))} ms`;
}

/** Keep a Markdown table intact when a label contains a pipe. */
function cell(text) {
  return String(text).replaceAll("|", "\\|");
}

/** Read every `*.json` file directly under `dir`. */
function readResults(dir) {
  const resolved = resolve(dir);
  let entries;
  try {
    entries = readdirSync(resolved, { withFileTypes: true });
  } catch {
    usage(`cannot read ${resolved}`);
  }
  const results = [];
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name) !== ".json") continue;
    const path = join(resolved, entry.name);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      usage(`${path} is not valid JSON: ${error instanceof Error ? error.message : error}`);
    }
    if (!Array.isArray(parsed.phases)) usage(`${path} has no phases array`);
    results.push({ ...parsed, file: path });
  }
  if (results.length === 0) usage(`${resolved} holds no *.json benchmark results`);
  return results;
}

/** Group runs by scenario, keeping insertion order for a stable report. */
function byScenario(results) {
  const scenarios = new Map();
  for (const result of results) {
    const name = String(result.scenario ?? "unnamed");
    if (!scenarios.has(name)) scenarios.set(name, []);
    scenarios.get(name).push(result);
  }
  return scenarios;
}

/**
 * Median and spread of one phase label across runs of one scenario.
 *
 * Spread is `(max - min) / median`, the number that says whether a delta can be
 * believed: a 12% difference between two sides means little when one side's own
 * runs vary by 20%.
 */
function phaseStats(results, label) {
  const values = results
    .flatMap((result) => result.phases)
    .filter((phase) => phase.label === label)
    .map((phase) => Number(phase.ms));
  if (values.length === 0) return null;
  const centre = median(values);
  const low = Math.min(...values);
  const high = Math.max(...values);
  return {
    runs: values.length,
    median: centre,
    min: low,
    max: high,
    spread: centre === 0 ? 0 : ((high - low) / centre) * 100,
  };
}

/** Every boolean leaf under `checks`, and every numeric `*errors` counter. */
function collectChecks(checks, prefix = "", found = { booleans: [], counters: [] }) {
  if (checks === null || typeof checks !== "object") return found;
  for (const [key, value] of Object.entries(checks)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "boolean") found.booleans.push({ path, value });
    else if (typeof value === "number" && /errors?$/i.test(key)) {
      found.counters.push({ path, value });
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      collectChecks(value, path, found);
    }
  }
  return found;
}

/**
 * Whether a boolean leaf states a rule the run has to satisfy.
 *
 * The CI runner writes `checks.invariants`, which is the contract. The research
 * harness predates it and mixes facts (`uploadsDir: false` is healthy, not a
 * failure) with assertions, so there the key name has to say that it is one.
 */
function isInvariant(path) {
  return /(?:Equal|Match|Matches|Identical|Sequential|Every)/.test(path.split(".").at(-1));
}

/** The scenario's detail line, from whatever the runner recorded. */
function describeScenario(results) {
  const config = results.find((result) => result.scenarioConfig)?.scenarioConfig ?? {};
  const parts = [];
  if (Number.isFinite(config.files)) parts.push(`${integer.format(config.files)} files`);
  if (Number.isFinite(config.totalBytes)) {
    parts.push(`${round(config.totalBytes / 1024 / 1024)} MiB`);
  }
  if (Number.isFinite(config.plaintextMiB)) parts.push(`${config.plaintextMiB} MiB`);
  if (Number.isFinite(config.incrementFiles)) {
    parts.push(`${integer.format(config.incrementFiles)} edited afterwards`);
  }
  return parts.join(" · ");
}

/** The union of phase labels: head's order first, then anything only base has. */
function phaseLabels(base, head) {
  const labels = [];
  for (const result of [...head, ...base]) {
    for (const phase of result.phases) {
      if (!labels.includes(phase.label)) labels.push(phase.label);
    }
  }
  return labels;
}

/** Render one scenario's phase table, and its worst delta (single-side: no delta). */
function renderTable(base, head, hasBaseline) {
  if (!hasBaseline) {
    const lines = ["| Phase | Median |", "| --- | ---: |"];
    for (const label of phaseLabels([], head)) {
      const stats = phaseStats(head, label);
      lines.push(`| ${cell(label)} | ${stats === null ? "—" : milliseconds(stats.median)} |`);
    }
    return { markdown: lines.join("\n"), worst: Number.NEGATIVE_INFINITY };
  }
  const lines = ["| Phase | Base (median) | PR (median) | Δ |", "| --- | ---: | ---: | ---: |"];
  let worst = Number.NEGATIVE_INFINITY;
  for (const label of phaseLabels(base, head)) {
    const before = phaseStats(base, label);
    const after = phaseStats(head, label);
    let delta = "—";
    if (before !== null && after !== null && before.median > 0) {
      const change = ((after.median - before.median) / before.median) * 100;
      worst = Math.max(worst, change);
      const unreliable =
        before.spread > UNRELIABLE_SPREAD_PERCENT || after.spread > UNRELIABLE_SPREAD_PERCENT;
      delta = percent(change) + (unreliable ? " ⚠" : "");
    }
    const beforeText = before === null ? "—" : milliseconds(before.median);
    const afterText = after === null ? "—" : milliseconds(after.median);
    lines.push(`| ${cell(label)} | ${beforeText} | ${afterText} | ${delta} |`);
  }
  return { markdown: lines.join("\n"), worst };
}

/** Summarise the correctness checks of every run on one side. */
function checkSummary(results) {
  let total = 0;
  let failedInvariants = 0;
  const failed = [];
  let requestErrors = 0;
  for (const result of results) {
    if (result.ok === false) failed.push("run reported ok=false");
    const found = collectChecks(result.checks ?? {});
    const invariants = found.booleans.filter(
      (entry) => entry.path.startsWith("invariants.") || isInvariant(entry.path),
    );
    total += invariants.length;
    for (const entry of invariants) {
      if (entry.value) continue;
      failedInvariants++;
      failed.push(entry.path);
    }
    requestErrors += found.counters.reduce((sum, entry) => sum + entry.value, 0);
  }
  const summary =
    total === 0
      ? "no invariant reported"
      : `${total - failedInvariants}/${total} invariants held${
          requestErrors > 0 ? `, ${requestErrors} request errors` : ""
        }`;
  return { summary, failed };
}

/** One run's environment, collapsed so it does not dominate the comment. */
function renderEnvironment(results) {
  const system = results.find((result) => result.system)?.system;
  if (!system) return "";
  const journal = results.find((result) => result.journalMode)?.journalMode;
  const fields = [
    ["OS", [system.platform, system.release].filter(Boolean).join(" ")],
    ["Architecture", system.arch],
    ["Runtime", system.runtime],
    ["CPU", system.cpu],
    ["Logical CPUs", system.logicalCpus],
    ["Journal", journal],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  return [
    "<details><summary>Environment</summary>",
    "",
    "| Field | Value |",
    "| --- | --- |",
    ...fields.map(([field, value]) => `| ${field} | ${cell(value)} |`),
    "",
    "</details>",
  ].join("\n");
}

/**
 * Render the sticky comment.
 *
 * The threshold is deliberately separate from the table: a hard number over noisy
 * wall-clock milliseconds should not decide whether a pull request can merge, so
 * the comment always renders and the exit code carries the verdict.
 */
function render({ base, head, runUrl, failOver }) {
  const hasBaseline = base.length > 0;
  const baseScenarios = byScenario(base);
  const headScenarios = byScenario(head);
  const order = ["many", "large", "churn"];
  const names = [...new Set([...headScenarios.keys(), ...baseScenarios.keys()])].toSorted(
    (left, right) => {
      const leftIndex = order.indexOf(left);
      const rightIndex = order.indexOf(right);
      return (
        (leftIndex === -1 ? order.length : leftIndex) -
        (rightIndex === -1 ? order.length : rightIndex)
      );
    },
  );
  const sections = [];
  const failedChecks = [];
  let worst = Number.NEGATIVE_INFINITY;

  for (const name of names) {
    const baseRuns = baseScenarios.get(name) ?? [];
    const headRuns = headScenarios.get(name) ?? [];
    if (headRuns.length === 0) continue;
    const detail = describeScenario([...headRuns, ...baseRuns]);
    const lines = [`### ${cell(detail === "" ? name : `${name} (${detail})`)}`, ""];

    if (!hasBaseline) {
      // A dispatch run: one side, absolute numbers, no delta to believe or doubt.
      const table = renderTable([], headRuns, false);
      const checks = checkSummary(headRuns);
      const spread = Math.max(
        0,
        ...phaseLabels([], headRuns).map((label) => phaseStats(headRuns, label)?.spread ?? 0),
      );
      lines.push(
        table.markdown,
        "",
        `Correctness: ${checks.summary}. Runs: ${headRuns.length}` +
          (headRuns.length > 1
            ? `; largest within-side spread ${round(spread)}%.`
            : " (single run; no spread estimate)."),
      );
      for (const failure of checks.failed) failedChecks.push(`${name}: ${failure}`);
    } else if (baseRuns.length === 0) {
      lines.push("_New scenario in this pull request — there is no baseline to compare against._");
    } else {
      const table = renderTable(baseRuns, headRuns, true);
      worst = Math.max(worst, table.worst);
      const baseChecks = checkSummary(baseRuns);
      const headChecks = checkSummary(headRuns);
      const spread = Math.max(
        0,
        ...phaseLabels(baseRuns, headRuns).flatMap((label) => [
          phaseStats(baseRuns, label)?.spread ?? 0,
          phaseStats(headRuns, label)?.spread ?? 0,
        ]),
      );
      lines.push(
        table.markdown,
        "",
        `Correctness: base ${baseChecks.summary} · PR ${headChecks.summary}. ` +
          `Runs: ${baseRuns.length} base, ${headRuns.length} PR; ` +
          (baseRuns.length > 1 && headRuns.length > 1
            ? `largest within-side spread ${round(spread)}%.`
            : "a single run per side, so there is no spread estimate."),
      );
      for (const failure of baseChecks.failed) failedChecks.push(`${name}: base: ${failure}`);
      for (const failure of headChecks.failed) failedChecks.push(`${name}: PR: ${failure}`);
    }
    sections.push(lines.join("\n"));
  }

  const verdict = [];
  if (failedChecks.length > 0) {
    verdict.push(`**Correctness check failed:** ${failedChecks.join(", ")}`);
  }
  if (hasBaseline && failOver !== null && worst > failOver) {
    verdict.push(`**Slower than the ${failOver}% threshold:** worst phase ${percent(worst)}.`);
  }

  const parts = [
    MARKER,
    "",
    "## Sync benchmark",
    "",
    hasBaseline
      ? "Medians of the same scenarios on the same runner, merge base against this pull request. " +
        `Wall-clock time over loopback; a change under ${NOISE_PERCENT}% is inside the noise of a ` +
        "shared CI runner."
      : "A single-side run (`workflow_dispatch`): absolute medians on this runner, with no " +
        "baseline to compare against. Wall-clock time over loopback.",
    "",
  ];
  if (verdict.length > 0) parts.push(...verdict, "");
  parts.push(sections.join("\n\n"), "", renderEnvironment([...head, ...base]), "");
  parts.push(
    "<sub>Rendered by `bun scripts/bench-report.ts`. ⚠ marks a phase whose own runs spread by " +
      "more than 20%, so its delta is not trustworthy. Timing is informational; a failing " +
      "correctness check is not.</sub>",
  );
  if (runUrl) parts.push("", `[Benchmark run](${runUrl})`);

  return {
    markdown: `${parts.filter((part, index) => !(part === "" && parts[index - 1] === "")).join("\n")}\n`,
    failed: failedChecks.length > 0,
    worst,
  };
}

const options = parseArgs(process.argv.slice(2));
if (!options.head) usage("--head is required");
const failOver = options["fail-over"] === undefined ? null : Number(options["fail-over"]);
if (failOver !== null && !Number.isFinite(failOver)) usage("--fail-over must be a number");
if (failOver !== null && !options.base) usage("--fail-over needs a --base to compare against");

const head = readResults(options.head);
const rendered = render({
  base: options.base ? readResults(options.base) : [],
  head,
  runUrl: options["run-url"] ?? "",
  failOver,
});

if (options.out) writeFileSync(options.out, rendered.markdown);
else process.stdout.write(rendered.markdown);

const failed = rendered.failed || (failOver !== null && rendered.worst > failOver);
process.exit(failed ? 1 : 0);

#!/usr/bin/env bun
/**
 * Run one sync benchmark scenario.
 *
 *   bun run bench <many|large|churn>
 *
 * Each scenario is one measured process: `packages/e2e/src/bench/sync.bench.test.ts`
 * starts its own server, database and vaults, writes one JSON result, and exits.
 * This wrapper only fixes the environment (`COURIER_BENCH=1`, the scenario) and
 * forwards everything else, so `BENCH_FILES`, `BENCH_LARGE_MIB`, `BENCH_RUN_ID`
 * and `BENCH_RESULTS_DIR` keep working.
 *
 * The scenarios are opt-in because they take seconds to minutes; the default suite
 * skips them (they need `COURIER_BENCH=1`). CI runs them from
 * `.github/workflows/bench.yml`.
 */
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const SCENARIOS = ["many", "large", "churn"];
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const scenario = process.argv[2] ?? "many";

if (!SCENARIOS.includes(scenario)) {
  console.error(`bench: unknown scenario "${scenario}"; expected ${SCENARIOS.join(", ")}.`);
  process.exit(2);
}

// The Bun running this wrapper is the same binary that runs Vitest; the benchmark
// output is inherited so the reporter and the `BENCH_RESULT` line reach the terminal
// unchanged.
const result = spawnSync(
  process.execPath,
  ["--bun", "vitest", "run", "packages/e2e/src/bench/sync.bench.test.ts"],
  {
    cwd: repo,
    stdio: "inherit",
    env: { ...process.env, COURIER_BENCH: "1", BENCH_SCENARIO: scenario },
  },
);
process.exit(result.status ?? 1);

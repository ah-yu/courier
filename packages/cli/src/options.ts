import { findVault, type CliConfig, type CliVault } from "./config";
import { t } from "./i18n";

/**
 * The CLI's argument decisions, as pure functions.
 *
 * `main.ts` is the only entry point that parses argv, so these live here instead of
 * inside the command actions: the two decisions are worth testing directly, and one
 * of them was **wrong**: `--interval 5m` became `Number("5m")` = `NaN`,
 * `NaN > 0` is false, and the periodic reconcile was switched off without a word. On a
 * headless machine that pass is the only catch-up there is: the server keeps no backlog
 * for a subscriber, so a notification missed while the socket was down is gone.
 */

/**
 * `--interval <minutes>`: how often the daemon re-runs a full reconcile.
 *
 * `0` disables it deliberately (documented in `docs/cli.md`); anything that is not a
 * non-negative number is refused, because silently reading it as "off" is the one
 * outcome a user cannot notice.
 */
export function parseIntervalMinutes(value: string): number {
  const text = value.trim();
  const minutes = Number(text);
  // `Number("")` is 0, and `0` deliberately means "no periodic reconcile" — so an empty
  // value must not read as the switch that turns the safety net off.
  if (text === "" || !Number.isFinite(minutes) || minutes < 0) {
    throw new Error(t("cli.options.error.interval", { value }));
  }
  return minutes;
}

/**
 * The bindings a command should act on: all of them, or the one named by `--vault`.
 *
 * `run`/`run --once` default to every bound vault. A `--vault` id is resolved here so a
 * typo fails before the daemon starts, instead of producing a process that quietly syncs
 * nothing.
 */
export function selectVaults(config: CliConfig, vaultId?: string): CliVault[] {
  if (config.vaults.length === 0) throw new Error(t("cli.error.notBound"));
  if (vaultId) {
    const vault = findVault(config, vaultId);
    if (!vault) throw new Error(t("cli.error.unknownVault", { vaultId }));
    return [vault];
  }
  if (config.vaults.length > 1) {
    throw new Error(t("cli.error.multipleVaults", { count: config.vaults.length }));
  }
  return config.vaults;
}

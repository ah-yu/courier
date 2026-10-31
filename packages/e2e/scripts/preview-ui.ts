#!/usr/bin/env bun
/**
 * Render a plugin surface to a PNG, outside Obsidian, from the **live** view's own markup.
 *
 *   bun run preview:ui                       # the conflict comparison, 900 px wide
 *   bun run preview:ui -- --width=380        # a narrow pane (the narrow-layout rules)
 *   bun run preview:ui -- --theme=dark
 *   bun run preview:ui -- --selector=.courier-conflict-diff.status --open=conflict
 *   bun run preview:ui -- --open=reload --vault=vault_b
 *   bun run preview:ui -- --open=reload --mobile --vault=vault_b
 *
 * Why this exists: a design pass needs to *look* at the page many times, and the two obvious
 * ways to get a picture are both worse. A Windows screen capture of the Obsidian window comes
 * back as a **frozen frame** (see `docs/plugin-ui-preview.md`), and the dev loop's own Obsidian
 * restart takes ~20 s per look. This script instead:
 *
 * 1. asks the running Obsidian, over its CLI, for the surface's `outerHTML` — so the markup is
 *    the real thing, produced by the plugin, never a hand-written replica;
 * 2. writes a small shell page that declares Obsidian's theme variables and links the plugin's
 *    real `styles.css`;
 * 3. renders that page with headless Chrome/Edge.
 *
 * What it is **not**: a pixel-truth of the app. Fonts and Obsidian's own theme sheet are
 * approximated, and the app's chrome (tab header, sidebar) is absent. Geometry that matters is
 * asserted in the real app instead — `bun run verify obsidian` (see the L3 rule in AGENTS.md).
 *
 * Requires Obsidian to be running on a vault that has Courier installed and enabled — a
 * disposable e2e vault (`bun run e2e:obsidian`) or a development vault
 * (`bun run --filter @courier/plugin setup:vault`). `--open=reload` drives the **running**
 * plugin, so that vault's copy of the plugin has to be rebuilt after a change.
 */
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { pathToFileURL } from "url";
import { evalInVault, vaultIsReachable } from "../src/obsidian/cli.ts";
import { e2eVaults, repoRoot } from "../src/obsidian/vaults.ts";

/** A surface this script knows how to open before dumping it. */
type Surface = "conflict" | "reload" | "none";

interface Options {
  vault: string;
  selector: string;
  width: number;
  height: number;
  theme: "light" | "dark";
  out: string;
  open: Surface;
  /** Render the surface inside a phone-sized frame with `body.is-phone`. */
  mobile: boolean;
}

const DEFAULTS: Options = {
  // This checkout's own e2e vault: the name carries the worktree, see `e2eVaults()`.
  vault: process.env.COURIER_PREVIEW_VAULT ?? e2eVaults()[0].name,
  selector: ".courier-conflict-diff",
  width: 900,
  height: 560,
  theme: "light",
  out: join(".agents", "ui-preview", "surface.png"),
  open: "conflict",
  mobile: false,
};

/** `--key=value` pairs, so a value may contain spaces; `--mobile` is a bare flag. */
function parseArgs(argv: string[]): Options {
  const options = { ...DEFAULTS };
  let selectorGiven = false;
  for (const arg of argv) {
    if (arg === "--mobile") {
      options.mobile = true;
      continue;
    }
    if (!arg.startsWith("--")) continue;
    const [rawKey, ...rest] = arg.slice(2).split("=");
    const value = rest.join("=");
    switch (rawKey) {
      case "vault":
        options.vault = value || options.vault;
        break;
      case "selector":
        options.selector = value || options.selector;
        selectorGiven = true;
        break;
      case "width":
        options.width = Number(value) || options.width;
        break;
      case "height":
        options.height = Number(value) || options.height;
        break;
      case "theme":
        options.theme = value === "dark" ? "dark" : "light";
        break;
      case "out":
        options.out = value || options.out;
        break;
      case "open":
        options.open = value === "none" ? "none" : value === "reload" ? "reload" : "conflict";
        break;
      case "help":
        console.log(
          "bun run preview:ui -- [--vault=<name>] [--selector=<css>] [--width=<px>] " +
            "[--height=<px>] [--theme=light|dark] [--out=<path>] " +
            "[--open=conflict|reload|none] [--mobile]\n" +
            "  --open=reload defaults --selector to .courier-reload-notice",
        );
        process.exit(0);
        break;
      default:
        console.warn(`preview:ui: ignoring unknown option --${rawKey}`);
    }
  }
  // `--open=reload` has exactly one surface to shoot, and the default selector names the
  // conflict view instead — asking for the card used to need both flags to avoid an empty
  // dump. An explicit selector still wins.
  if (options.open === "reload" && !selectorGiven) options.selector = ".courier-reload-notice";
  return options;
}

/**
 * Open a comparison on a demo conflict pair, creating the pair when the vault has none.
 *
 * The pair is deliberately obvious (one changed line each side) so a layout is judged on a
 * table with a header, a `same` row and a `change` row — not on an empty page.
 */
async function openConflictComparison(vault: string): Promise<void> {
  // Careful with escapes: this body is a TypeScript template literal that becomes JavaScript
  // source in the renderer, so a newline has to be written `\\n` here to arrive as `\n` there.
  await evalInVault<unknown>(
    vault,
    `
    const note = 'preview-surface.md';
    const copy = 'preview-surface-2026-01-01-120000.conflict.md';
    const body = (line) => '# Release notes\\n\\nThe sync engine keeps every note on one chain.\\n' +
      line + '\\nThe parked copy is kept beside the note.\\n\\n## Settings\\n\\n- Device label: studio\\n';
    for (const [p2, text] of [[note, body('Conflicts are resolved by the remote version.')],
                              [copy, body('Conflicts are resolved locally, and the parked copy wins.')]]) {
      const f = app.vault.getAbstractFileByPath(p2);
      if (f) await app.vault.modify(f, text); else await app.vault.create(p2, text);
    }
    const plugin = app.plugins.plugins.courier;
    await plugin.openConflictDiff(copy);
    await new Promise((r) => setTimeout(r, 900));
    return true;
    `,
    60_000,
  );
}

/**
 * Put the settings-reload card on screen, so its live markup can be dumped.
 *
 * `showReloadNotice` is TypeScript-`private`, not runtime-private: the dev build does not
 * minify, so the method is reachable here. This is a development tool, and adding a public
 * method to the plugin just for it would put preview code on the product surface.
 */
async function openReloadCard(vault: string): Promise<void> {
  await evalInVault<unknown>(
    vault,
    `
    const plugin = app.plugins.plugins.courier;
    if (!plugin || typeof plugin.showReloadNotice !== 'function') {
      throw new Error('Courier is not loaded, or this build minified showReloadNotice');
    }
    if (plugin.reloadPopup) plugin.reloadPopup.destroy();
    plugin.showReloadNotice();
    await new Promise((r) => setTimeout(r, 400));
    return true;
    `,
    60_000,
  );
}

/**
 * The surface's live markup, as an HTML document ready for the browser.
 *
 * The dump is one `eval`, so it stays small — see the payload rule in `docs/plugin-ui-preview.md`.
 * Obsidian clones a dropdown with `is-measuring` while sizing it; that clone is not something
 * the user ever sees, so it is dropped before the page is written (otherwise a preview shows
 * two selects where the app shows one).
 */
async function dumpSurface(vault: string, selector: string): Promise<string> {
  const html = await evalInVault<string>(
    vault,
    `
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return '';
    const clone = el.cloneNode(true);
    for (const node of Array.from(clone.querySelectorAll('.is-measuring'))) node.remove();
    return clone.outerHTML;
    `,
    60_000,
  );
  if (!html) {
    throw new Error(
      `no element matching "${selector}" in ${vault}. Is the surface open? ` +
        "Pass --open=conflict (or --open=reload) to open one, or check --selector.",
    );
  }
  return html;
}

/** Obsidian's light and dark theme values, as far as this page needs them. */
const THEME: Record<"light" | "dark", Record<string, string>> = {
  light: {
    "--text-normal": "#222222",
    "--text-muted": "#666666",
    "--text-faint": "#999999",
    "--text-on-accent": "#ffffff",
    "--text-error": "#d32f2f",
    "--background-primary": "#ffffff",
    "--background-primary-alt": "#fafafa",
    "--background-secondary": "#f6f6f6",
    "--background-secondary-alt": "#ededed",
    "--background-modifier-border": "#e0e0e0",
    "--background-modifier-hover": "#eeeeee",
    "--background-modifier-error": "#e93147",
    "--interactive-accent": "#8a5cf5",
    "--interactive-accent-hover": "#7a4ce5",
    "--color-red": "#e93147",
    "--color-green": "#08b94e",
    "--color-yellow": "#e0ac00",
    "--color-blue": "#086ddd",
  },
  dark: {
    "--text-normal": "#dadada",
    "--text-muted": "#a0a0a0",
    "--text-faint": "#707070",
    "--text-on-accent": "#ffffff",
    "--text-error": "#ff6b6b",
    "--background-primary": "#1e1e1e",
    "--background-primary-alt": "#232323",
    "--background-secondary": "#262626",
    "--background-secondary-alt": "#2f2f2f",
    "--background-modifier-border": "#3d3d3d",
    "--background-modifier-hover": "#333333",
    "--background-modifier-error": "#e93147",
    "--interactive-accent": "#8a5cf5",
    "--interactive-accent-hover": "#9a6cff",
    "--color-red": "#fb464c",
    "--color-green": "#44cf6e",
    "--color-yellow": "#e0de71",
    "--color-blue": "#53a6f0",
  },
};

/** Obsidian's own component styles this page relies on, reduced to what a surface uses. */
const COMPONENT_CSS = `
  :root {
    --font-interface: Inter, "Segoe UI", system-ui, sans-serif;
    --font-monospace: "Cascadia Mono", Consolas, monospace;
    --font-text: Inter, "Segoe UI", system-ui, sans-serif;
    --font-ui-smaller: 12px;
    --font-ui-small: 13px;
    --font-ui-medium: 15px;
    --radius-s: 4px;
    --radius-m: 8px;
    --radius-l: 12px;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--background-primary); color: var(--text-normal); font-family: var(--font-interface); }
  /* The leaf's content box: what a view is given inside a tab. */
  .preview-frame { height: 100%; box-sizing: border-box; padding: 0; display: flex; flex-direction: column; }
  .setting-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; }
  .setting-item-info { display: flex; flex-direction: column; }
  .setting-item-name { font-size: var(--font-ui-small); }
  .setting-item-control { display: flex; align-items: center; gap: 8px; }
  .setting-item-control input[type=text] { padding: 4px 8px; border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s); background: var(--background-secondary); color: var(--text-normal); font: inherit; }
  select.dropdown { padding: 4px 24px 4px 8px; border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s); background: var(--background-secondary); color: var(--text-normal); font: inherit; }
  button { padding: 6px 12px; border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s); background: var(--background-secondary); color: var(--text-normal); font: inherit; font-size: var(--font-ui-small); }
  button.mod-cta { border-color: transparent; background: var(--interactive-accent); color: var(--text-on-accent); }
  .checkbox-container { display: inline-flex; width: 30px; height: 18px; border-radius: 9px; background: var(--background-modifier-border); }
  .checkbox-container.is-enabled { background: var(--interactive-accent); }
  .modal { padding: 16px; }
  .modal-title, h1, h2 { font-size: var(--font-ui-medium); }
  p { margin: 0 0 1em; }
`;

/** Wrap a surface's markup in a page that looks like the app would render it. */
function buildPage(
  html: string,
  selector: string,
  theme: "light" | "dark",
  width: number,
  mobile: boolean,
): string {
  const vars = Object.entries(THEME[theme])
    .map(([key, value]) => `${key}: ${value};`)
    .join("\n      ");
  // The phone frame is a page-level simulation: `--mobile` puts the platform classes on the
  // body (which is what the card's phone rules select on) and constrains the surface to a
  // 390×844 canvas. `position: fixed` is changed to `absolute` so the card resolves against
  // that canvas instead of the browser window, which cannot be narrower than ~500 px on
  // Windows. Safe area and the mobile nav are simulated with a variable and a placeholder.
  const mobileCss = mobile
    ? `
      body {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        padding: 24px;
      }
      .preview-frame {
        position: relative;
        flex: 0 0 auto;
        width: ${width}px;
        height: 844px;
        overflow: hidden;
        border-radius: 36px;
        background: var(--background-primary);
        box-shadow: 0 18px 70px rgba(0, 0, 0, 0.32);
        /* The two values the sheet's offset is built from: Obsidian's 52 px floating nav
           plus an iPhone-sized 34 px home-indicator inset. */
        --mobile-toolbar-height: 52px;
        --safe-area-inset-bottom: 34px;
      }
      .preview-frame .courier-reload-notice {
        position: absolute;
      }
      /* A stand-in for Obsidian's floating mobile nav: it makes the sheet's gap legible. */
      .preview-frame::after {
        content: "";
        position: absolute;
        right: 12px;
        bottom: 34px;
        left: 12px;
        height: 52px;
        border-radius: 26px;
        background: var(--background-secondary-alt);
      }`
    : `
      /* The pane's width is a constraint of the page, not of the browser window: a headless
         window cannot be narrower than ~500 px on Windows, so a narrow-pane preview has to
         squeeze the container instead. */
      .preview-frame { width: ${width}px; }`;
  return `<!doctype html>
<html lang="zh" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <title>Courier UI preview — ${selector}</title>
    <link rel="stylesheet" href="styles.css" />
    <style>
      :root {
      ${vars}
      }
${COMPONENT_CSS}
      /* A screenshot is one frame: entry animations are cut to their settled state, so
         the PNG shows the card as it reads after a moment instead of mid-fade. */
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }
${mobileCss}
      body { background: ${theme === "dark" ? "#141414" : "#ececec"}; }
    </style>
  </head>
  <body${mobile ? ' class="is-mobile is-phone"' : ""}>
    <div class="preview-frame">
${html}
    </div>
  </body>
</html>
`;
}

/** The first headless-capable browser on this machine. */
function findBrowser(): string {
  const candidates = [
    process.env.COURIER_PREVIEW_BROWSER,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter((path): path is string => typeof path === "string" && path.length > 0);
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      "no Chrome/Edge found for the headless render. Set COURIER_PREVIEW_BROWSER to its path.",
    );
  }
  return found;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!(await vaultIsReachable(options.vault))) {
    throw new Error(
      `Obsidian is not answering for vault "${options.vault}". Open it first ` +
        "(a registered vault with Courier loaded; `bun run e2e:obsidian` creates the disposable pair).",
    );
  }

  if (options.open === "conflict") await openConflictComparison(options.vault);
  else if (options.open === "reload") await openReloadCard(options.vault);
  const html = await dumpSurface(options.vault, options.selector);

  // A phone frame wider than the headless window would be clipped, so the page width is
  // capped in mobile mode; the documented command passes 390.
  const width = options.mobile ? Math.min(options.width, 430) : options.width;
  // The frame is 844 px plus 24 px of padding on each side; a shorter window would cut it.
  const height = options.mobile ? Math.max(options.height, 920) : options.height;

  // The preview lives beside a copy of the plugin's real stylesheet: a `file://` page cannot
  // reach into `packages/`, and Chrome caches a file it has already read for one URL.
  const outPath = resolve(options.out);
  const outDir = dirname(outPath);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "styles.css"), readPluginStylesheet(), "utf8");
  const pageName = `${outPath.replace(/\.png$/i, "")}.html`;
  writeFileSync(
    pageName,
    buildPage(html, options.selector, options.theme, width, options.mobile),
    "utf8",
  );

  // The headless window has a ~500 px floor on Windows. A desktop preview therefore keeps a
  // window wider than the phone breakpoint even when the page's own frame is narrow — the
  // frame constrains the surface, the window decides which media queries apply.
  const windowWidth = options.mobile ? Math.max(width + 48, 520) : Math.max(options.width, 900);

  const browser = findBrowser();
  execFileSync(
    browser,
    [
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      `--window-size=${windowWidth},${height}`,
      `--screenshot=${outPath}`,
      pathToFileURL(pageName).href,
    ],
    { stdio: "ignore" },
  );

  console.log(`preview:ui  ${outPath}`);
  console.log(`            page   ${pageName}`);
  console.log(
    `            vault  ${options.vault}, selector ${options.selector}, ${width}px wide` +
      `${options.mobile ? " (phone frame)" : ""}`,
  );
}

/** The plugin's shipped stylesheet — the thing a preview is actually judging. */
function readPluginStylesheet(): string {
  return readFileSync(join(repoRoot(), "packages", "plugin", "styles.css"), "utf8");
}

main().catch((error: unknown) => {
  console.error(`preview:ui failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

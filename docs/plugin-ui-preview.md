# How to "see" the plugin UI while developing

> **Status: `authoritative` (only as to "how to render the plugin UI and take a look").**
>
> This is a **development-time tool usage**, not a product contract, and it does not run in `bun run verify`. It answers one question:
> **after changing `styles.css` or some `ItemView` / `Modal`, besides "restart Obsidian and look with your eyes", how else can you confirm what it looks like.**
>
> The conclusion up front: **you can look, but no screenshot is geometric truth.** Pixel-level fact comes only from L3 (a real Obsidian + `getBoundingClientRect`);
> screenshots are only for design iteration — judgments like "this looks off" about typography, whitespace and colour.

## Three tools, each covering one stretch

| Tool                                  | What you get                                                 | When to use it                                                                             | Cost                               |
| ------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------- |
| `bun run preview:ui`                  | a PNG rendered from the **live DOM** + the real `styles.css` | design iteration: change a version, look at a version                                      | ~3 s / image                       |
| Measuring geometry in a real Obsidian | the numbers from `getBoundingClientRect()`                   | asserting "the centres line up", "the divider is full height", "the button is not clipped" | ~1 s / run, needs Obsidian running |
| L2 stub (`plugin.e2e.test.ts`)        | component tree, text, class names                            | "is the structure right": is that button there, what does the label say                    | milliseconds, no image             |

**The three cannot replace one another.** Structure right ≠ good-looking; good-looking ≠ geometry right (fonts, line height and theme all change the actual position).

## Tool A: `bun run preview:ui` (live DOM → headless Chrome)

```bash
bun run preview:ui                                   # conflict comparison view, 900px wide, light
bun run preview:ui -- --width=380                    # narrow window (triggers the narrow-layout rules)
bun run preview:ui -- --theme=dark                   # dark
bun run preview:ui -- --selector=.courier-conflict-replace --open=none   # switch to another surface
bun run preview:ui -- --out=.agents/ui-preview/x.png --height=620

# The "Settings synced" reload card: first make the running plugin show the card, then grab its DOM
# (the default selector for --open=reload is .courier-reload-notice, no need to pass it again)
bun run preview:ui -- --vault=vault_b --open=reload --height=300
bun run preview:ui -- --vault=vault_b --open=reload \
  --theme=dark --height=300 --out=.agents/ui-preview/reload-dark.png

# Phone bottom sheet: 390×844 canvas + is-phone class + placeholder mobile navigation
bun run preview:ui -- --vault=vault_b --open=reload \
  --mobile --width=390 --height=920 --out=.agents/ui-preview/reload-mobile.png

# The conflict comparison on a phone: `--mobile` puts `is-phone` on the body (the phone rules
# select on it) in a 390 px-wide phone frame. The running app is still a desktop instance, so
# this opens in 并排; click 统一 in the running app, then re-run with `--open=none` to capture
# the phone's default single-column presentation.
bun run preview:ui -- --open=conflict --mobile --width=390 --height=920
bun run preview:ui -- --open=none --mobile --width=390 --height=920

# The version-history tab: open it in the running vault first (its chain is fetched on open, so
# the DOM exists only while the leaf does), then grab the view's content element
bun run preview:ui -- --selector=.courier-version-history-view --open=none --width=1200
```

Output: the PNG named by `--out` (default `.agents/ui-preview/surface.png`), plus the `.html` (a reproducible page) and `styles.css` (the exported plugin styles) in the same directory.

**How `--open=reload` works**: the script calls the plugin's `showReloadNotice()` inside the running vault (the dev build is not minified, and TypeScript's `private` exists only at the type level), so it needs Courier already loaded in that vault, and after changing `main.js` you must rebuild/reload the plugin first; with `--open=reload` the default `--selector` is `.courier-reload-notice`.
`--mobile` is only a **layout approximation**: it adds `is-mobile is-phone` to the preview page's `<body>`, turns fixed positioning into absolute inside a 390×844 frame, simulates the bottom inset per Obsidian's 52px floating navigation + 34px safe area (`--width` is capped at 430), and uses a placeholder bar to stand in for the mobile navigation; the safe area is the simulated `34px` value, not a real-device value. Pixel truth still comes from a real Obsidian in L3.

**Why it is credible**: that stretch of HTML in the page is not a hand-written replica; the script asks the **running plugin** for its `outerHTML` through the Obsidian CLI — that is, the DOM the plugin actually produces. The stylesheet is also the original `packages/plugin/styles.css`. So questions of the "are the class names right, did the CSS selectors match" kind it reflects faithfully.

**Why it cannot be truth**:

- fonts are approximate (Obsidian uses system fonts + its own theme tables), and line height deviates from real rendering;
- no Obsidian's own theme CSS, no tab bar/sidebar;
- the preview page turns off animations and transitions, so what you capture is the settled frame: good for typography, not for motion;
- `--width` constrains only the **container inside the page**, not the browser window (see the minimum-width pitfall below); `--mobile` simulates a phone with a container width, it does not really turn the browser window into 390px.
- the mobile safe area, `--mobile-toolbar-height` and the navigation bar are all simulated values; the actual insets on a real device/emulator may differ.

Script location: `packages/e2e/scripts/preview-ui.ts`. It needs Obsidian running, with **a vault that has Courier installed** open: a disposable vault such as `courier-e2e-a` (`bun run e2e:obsidian`, one-time), or one of the development vaults `bun run dev` provisions (`vault_a` / `vault_b` in the primary checkout, `vault_a-<worktree>` / `vault_b-<worktree>` elsewhere — see [plugin.md](plugin.md#dev-loop-and-test-vaults)).
`--open=conflict` creates a pair of demo conflict files in the vault itself (`preview-surface.md` + a copy) and opens the comparison view; `--open=reload` calls the **running plugin**, so after changing plugin code rebuild/reload first; `--open=none` means "the surface is already open, just grab it".

## Tool B: measuring geometry in a real Obsidian (the only authority)

One `eval` is enough; no screenshot needed:

```bash
obsidian vault=courier-e2e-a eval "code=$(cat probe.txt)"
```

The name is the checkout's own (`courier-e2e-a` in the primary checkout,
`courier-e2e-a-<worktree>` in a linked one — `obsidian vaults verbose` lists what exists).

`probe.txt` contents (swap the selector and the vault name):

```js
(async () => {
  const leaf = app.workspace.getLeavesOfType("courier-conflict-diff")[0];
  const el = leaf.view.containerEl.querySelector(".courier-conflict-diff");
  const box = (sel) => {
    const e = el.querySelector(sel);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return {
      x: Math.round(b.left),
      y: Math.round(b.top),
      w: Math.round(b.width),
      h: Math.round(b.height),
    };
  };
  return {
    win: [window.innerWidth, window.innerHeight],
    header: box(".courier-conflict-diff-header"),
    title: box(".courier-conflict-diff-title"),
    stats: box(".courier-conflict-diff-stats"),
    layout: box(".courier-segmented"),
    replace: box(".courier-conflict-diff-replace"),
    rows: box(".courier-diff-rows"),
  };
})().then(
  (r) => "OK:" + JSON.stringify(r),
  (e) => "ERR:" + e.message,
);
```

A probe like this becomes an **assertion** once it is written into `packages/e2e/src/obsidian/plugin-control.ts` (that is where the `centreSpread` / `replaceOnHeaderLine` / `layout.headerWidth` returned by `readConflictDiff` come from); for a one-off investigation, a temporary file like the above is enough — do not scatter probes through the tests.

`getLeavesOfType(...)` uses Obsidian's own leaf table, which is more reliable than querying the DOM; use DOM queries only when you need styles/layout.

## Tool C: L2 stub (structure)

`buttonsIn` / `elementsWithClass` in `packages/e2e/src/plugin.e2e.test.ts` read the fake DOM directly: good for asserting "the header has a replace button and no close button", "the counter copy is `+1` / `−1`". It runs in milliseconds; **when changing the UI, make it green first**, then go look at images and measure geometry.

## Don't do it: screen capture

**Capturing the Obsidian window on Windows gets you a "frozen frame".** Measured: temporarily giving the title a 20pt `MARKER` on a yellow background, the PNG from `CopyFromScreen` was **byte-for-byte identical in hash** to the one before the change — the screen copy hits the compositor's old frame, not the window's current content. The same symptom makes people misjudge "the CSS did not take effect", and therefore go changing styles that were already correct.

`PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)` returns an **all-white** bitmap for Electron/Chromium.

The only reliable way to "see the real window" is: **a human looks** (this is L4), or a combination of Tool A's render + Tool B's measurement.

## Operational pitfalls (all of them hit)

1. **The `eval` payload cannot be large.** The request body is sent over the socket to the Obsidian main process and then `JSON.parse`d, and anything above a few KB gets truncated:
   the main process throws a `SyntaxError: ... is not valid JSON` dialog, and **every CLI call fails afterwards**, until Obsidian is restarted.
   The symptom is L3 failing en masse and `readConflictDiff` timing out. Rule: **write no comments** in the template, keep variable names short, and do one thing per `eval`.
   Measured in this project: ~2.6 KB works, ~4.3 KB blows up.
2. **The `is-measuring` clone.** When Obsidian measures a dropdown's size it temporarily clones a `<select>` carrying `.is-measuring`.
   Queries must be written `select:not(.is-measuring)`; delete it before exporting `outerHTML`, otherwise the preview draws two dropdowns.
3. **Plugin CSS is cached in memory.** After changing `packages/plugin/styles.css`, reloading `main.js` alone is not enough; styles take effect only after
   **disabling/enabling the plugin or restarting Obsidian**. Forgetting this step leads to the wrong conclusion "my CSS has no effect".
4. **Hot reload leaves stale view types.** When reloading repeatedly with `app.plugins.disablePlugin/enablePlugin`,
   `registerView` reports `Attempting to register an existing view type`, and the view is still rendered by the **old class** afterwards —
   hence "the change did not take effect". During development, restart Obsidian; do not enable repeatedly in the same instance.
5. **Stale comparison tabs.** `readConflictDiff` takes the last of `getLeavesOfType(...)`, but assertions of the "is it still open" kind
   get disturbed by a tab left over from a previous run. At the start of an L3 case, clear the field with `closeConflictDiffs()`.
6. **Browser minimum window width.** On Windows, headless Chrome's `--window-size` has a floor of about 500px: pass 380
   and you get a 512-wide viewport plus a cropped image. So narrow previews constrain the **container width inside the page**, and the PNG may still be
   wider than `--width` (the excess is the page background).
7. **`\n` inside the `eval` template.** The template string is first parsed once by TypeScript in the script: writing `\n` becomes a real newline,
   which breaks the string literal at the rendering end (`Invalid or unexpected token`). Write `\\n`.
8. **Don't use `SetWindowPos` to adjust the Obsidian window.** PowerShell variable names are case-insensitive, so `$h` (the handle) overwrites
   the `$H` (height) parameter, writing the window 43690px tall and storing that in Obsidian's window state — after which every screenshot and `GetWindowRect`
   is broken. To reset it, use `SetWindowPlacement` and explicitly restore `normalPosition`.

## Relation to the verification ladder

The full workflow for changing the UI:

1. `bun run test` / L2 — structure right (buttons, copy, class names);
2. `bun run preview:ui` — look at typography, whitespace, narrow windows version by version, iterate fast;
3. `bun run verify obsidian` — measure geometry in a real Obsidian and **assert** (font size, line height and theme can all change the numbers you saw in the preview);
4. a human looks — L4, the final aesthetic call.

**Only step 3 can become a CI gate.** The first two are for your own eyes.

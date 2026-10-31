import type { App } from "obsidian";
import { isFolderCoveredByExclusion } from "../shared/excluded-folders";

/**
 * Grey out the rows of excluded folders — and the files inside them — in Obsidian's file
 * explorer.
 *
 * The engine's excluded folders are a **device-local scope**, and a folder the user
 * excluded looks exactly like one that is syncing unless the explorer says otherwise.
 * This module is the visual half: the plugin has no public per-row render hook, so the
 * rows are decorated by watching the explorer's DOM — the same technique the conflict
 * action uses for its chip — and the class is kept current as the tree is rebuilt, a
 * folder is expanded, a row is renamed or a popout opens.
 *
 * Display-only: no engine decision reads this. The decoration follows the excluded list
 * automatically — it is installed with the plugin and refreshed when the dialog saves a
 * new list; there is no separate preference to switch it on.
 */

/**
 * The class added to an excluded folder's `.nav-folder-title` **and** to the
 * `.nav-file-title` of every file inside it.
 */
export const EXCLUDED_PATH_ROW_CLASS = "courier-excluded-path-dimmed";

/** Both explorer row kinds: folder rows and file rows carry the same `data-path`. */
const EXPLORER_ROW_SELECTOR = ".nav-folder-title[data-path], .nav-file-title[data-path]";

/** The slice of an explorer row this module needs (so the rule is unit-testable). */
export interface PathTitleElement {
  getAttribute(name: string): string | null;
  addClass(cls: string): void;
  removeClass(cls: string): void;
}

/**
 * Add or remove the dimmed class on one explorer row.
 *
 * A path is covered when it **is** an excluded folder or lives under one, so the whole
 * excluded subtree greys — its child folders and the files inside them are excluded too,
 * and leaving any of them normal would suggest they still sync. A path that stops being
 * covered (the exclusion was removed, or the row was renamed) loses the class.
 */
export function decorateExcludedPathRow(
  titleEl: PathTitleElement,
  excludedFolders: readonly string[],
): void {
  const path = titleEl.getAttribute("data-path");
  if (!path || !isFolderCoveredByExclusion(path, excludedFolders)) {
    titleEl.removeClass(EXCLUDED_PATH_ROW_CLASS);
    return;
  }
  titleEl.addClass(EXCLUDED_PATH_ROW_CLASS);
}

export interface ExcludedFolderDimmingOptions {
  /** Read the current excluded-folder list; it changes when the dialog saves. */
  excludedFolders: () => readonly string[];
}

/** The handle the plugin keeps so it can refresh or dispose the decoration. */
export interface ExcludedFolderDimming {
  /** Re-evaluate every known explorer row, after the setting or the list changed. */
  refresh(): void;
  dispose(): void;
}

/**
 * Attach the decoration to every file explorer and follow it as it rebuilds.
 *
 * Mirrors `installFileExplorerActions`: a layout change can move or rebuild the explorer,
 * a popout has its own document, and the tree re-renders rows on its own schedule. The
 * work is per-row and query-only on added subtrees, so a large vault is not re-scanned on
 * every mutation.
 */
export function installExcludedFolderDimming(
  app: App,
  options: ExcludedFolderDimmingOptions,
): ExcludedFolderDimming {
  const observers: MutationObserver[] = [];
  const containers = new Set<HTMLElement>();
  let disposed = false;

  const decorate = (title: HTMLElement): void => {
    decorateExcludedPathRow(title, options.excludedFolders());
  };

  const sweep = (root: ParentNode): void => {
    for (const title of root.querySelectorAll<HTMLElement>(EXPLORER_ROW_SELECTOR)) {
      decorate(title);
    }
  };

  /** The explorer row a mutation happened inside, if any (the row may itself be the target). */
  const nearestRow = (node: Node | null): HTMLElement | null => {
    let current: Node | null = node;
    while (current !== null && current.nodeType === 1) {
      const element = current as HTMLElement;
      if (element.matches?.(EXPLORER_ROW_SELECTOR)) return element;
      current = element.parentElement;
    }
    return null;
  };

  const observe = (container: HTMLElement): void => {
    containers.add(container);
    sweep(container);
    const observer = new MutationObserver((mutations) => {
      // A device with no excluded folders has nothing to decorate: skip the per-row
      // work entirely. The observer stays attached so the first exclusion — saved later
      // from the manage dialog — starts working without reinstalling anything, and
      // `refresh()` still sweeps to remove classes when the list becomes empty.
      if (options.excludedFolders().length === 0) return;
      for (const mutation of mutations) {
        const row = nearestRow(mutation.target);
        if (row !== null) decorate(row);
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          const element = node as HTMLElement;
          if (element.matches?.(EXPLORER_ROW_SELECTOR)) decorate(element);
          for (const title of element.querySelectorAll?.<HTMLElement>(EXPLORER_ROW_SELECTOR) ??
            []) {
            decorate(title);
          }
        }
      }
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-path"],
    });
    observers.push(observer);
  };

  /**
   * (Re)attach to every explorer open right now. Observers are rebuilt from the collected
   * containers rather than accumulated, exactly like the conflict action's own pass.
   */
  const attach = (): void => {
    for (const observer of observers.splice(0)) observer.disconnect();
    for (const leaf of app.workspace.getLeavesOfType("file-explorer")) {
      const container = (leaf.view as { containerEl?: HTMLElement } | undefined)?.containerEl;
      if (container) containers.add(container);
    }
    for (const container of containers) observe(container);
  };

  attach();
  app.workspace.onLayoutReady(() => {
    if (!disposed) attach();
  });
  const layoutRef = app.workspace.on("layout-change", () => attach());
  const windowRef = app.workspace.on("window-open", (_workspaceWindow, window) => {
    if (!window?.document) return;
    for (const container of window.document.querySelectorAll<HTMLElement>(".nav-files-container")) {
      observe(container);
    }
  });

  return {
    refresh: () => {
      if (disposed) return;
      for (const container of containers) sweep(container);
    },
    dispose: () => {
      disposed = true;
      for (const observer of observers.splice(0)) observer.disconnect();
      for (const container of containers) {
        for (const title of container.querySelectorAll<HTMLElement>(
          `.nav-folder-title.${EXCLUDED_PATH_ROW_CLASS}, .nav-file-title.${EXCLUDED_PATH_ROW_CLASS}`,
        )) {
          title.removeClass(EXCLUDED_PATH_ROW_CLASS);
        }
      }
      containers.clear();
      app.workspace.offref(layoutRef);
      app.workspace.offref(windowRef);
    },
  };
}

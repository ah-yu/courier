import { Modal, setIcon, TFolder, type App } from "obsidian";
import { t, plural } from "../../i18n";
import {
  buildExcludedFolderTree,
  compactExcludedFolders,
  hasExcludedAncestor,
  isFolderCoveredByExclusion,
  toggleExcludedFolder,
  type ExcludedFolderNode,
} from "../../shared/excluded-folders";

/**
 * What the tree needs from its caller.
 *
 * A narrow port rather than the plugin class, so the same dialog serves the settings page
 * (applying to the live scope) and the connection setup (updating a draft that has not been
 * saved yet). The list is a snapshot taken when the dialog opens.
 */
export interface ExcludedFoldersModalHost {
  /** The folders the dialog starts from (the saved list, or the setup draft). */
  excludedFolders: readonly string[];
  /** Apply the selection from 完成. Errors keep the dialog open. */
  apply(folders: string[]): Promise<void>;
}

/**
 * The "manage excluded folders" dialog: a folder tree with one checkbox per folder.
 *
 * This is the interaction Obsidian Sync's settings page offers — one row with a
 * **Manage** button, and the list itself in a dialog rather than on the page — and it is
 * the right shape for a folder tree: the page stays quiet, the tree can scroll, and a
 * parent checkbox visibly covers its children.
 *
 * Changes are collected locally and written **once**, on 完成: every write restarts the
 * sync host (the scope is read when the engine is built), so applying a delta per
 * checkbox would interrupt syncing once per click. Closing the dialog any other way
 * discards the pending selection, exactly like a cancel. Pressing 完成 with nothing
 * selected still calls {@link ExcludedFoldersModalHost.apply} with an empty list — that is
 * how a first-time setup records "configured, nothing excluded".
 *
 * The file explorer's greyed-out rows follow the saved list automatically; there is no
 * display preference to configure here.
 */
export class ExcludedFoldersModal extends Modal {
  /** The pending selection among folders that exist right now. */
  private selected: string[] = [];
  /**
   * Excluded paths whose folder is gone.
   *
   * Deleting a folder does not remove the rule: the exclusion is a path, and a folder
   * recreated at the same path should stay excluded rather than silently start syncing.
   * These entries are shown in their own section (not as checked rows in the live tree)
   * so the user can see what still applies and remove it deliberately.
   */
  private missing: string[] = [];
  /**
   * Excluded paths this dialog cannot render: the config folder and hidden (dot)
   * folders are not in Obsidian's vault index, so they have no row in the tree.
   *
   * They are still the user's setting (a CLI `--exclude-folders` may have written one),
   * so 完成 writes them back unchanged instead of dropping them because the tree has no
   * place to show them. They do not affect sync anyway: the engine applies the list
   * outside the config folder only, and dot-folders never sync.
   */
  private untouched: string[] = [];
  /** Folders whose children are collapsed. Empty = everything expanded. */
  private readonly collapsed = new Set<string>();
  /** Path → its checkbox, so a parent toggle can update the children in place. */
  private readonly checkboxes = new Map<string, HTMLInputElement>();
  private summaryEl!: HTMLElement;
  /** The line under the tree that says why the last 完成 did not save. */
  private errorEl!: HTMLElement;
  /**
   * Why the last 完成 did not save, or null.
   *
   * Kept as state rather than announced with a toast: the dialog stays open so the
   * selection is not lost, and the reason belongs next to the button that failed.
   */
  private error: string | null = null;

  constructor(
    app: App,
    private readonly host: ExcludedFoldersModalHost,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(t("dialog.excludedFolders.title"));
    // An explicit child of an excluded folder is redundant (the parent already covers
    // it) and cannot be shown as an independently usable row: compact before rendering.
    const compacted = compactExcludedFolders(this.host.excludedFolders);
    this.untouched = compacted.filter((folder) => this.isHiddenOrConfig(folder));
    const excluded = compacted.filter((folder) => !this.isHiddenOrConfig(folder));
    const existing = this.existingFolderPaths();
    this.selected = excluded.filter((folder) => existing.has(folder));
    this.missing = excluded.filter((folder) => !existing.has(folder));
    this.render();
  }

  /** Every folder that exists in the vault right now, minus dot-folders and the config folder. */
  private existingFolderPaths(): Set<string> {
    const folders = new Set<string>();
    for (const file of this.app.vault.getAllLoadedFiles()) {
      if (!(file instanceof TFolder)) continue;
      const path = file.path;
      if (!path || path === "/" || this.isHiddenOrConfig(path)) continue;
      folders.add(path);
    }
    return folders;
  }

  /** Dot-folders and the config folder are not vault folders as far as sync is concerned. */
  private isHiddenOrConfig(path: string): boolean {
    const configDir = this.app.vault.configDir;
    if (path === configDir || path.startsWith(`${configDir}/`)) return true;
    return path.split("/").some((segment) => segment.startsWith("."));
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    // Keep the dialog inside a settings window that is shorter than the tree; the tree
    // itself scrolls, and this is the safety net for a very small window.
    contentEl.style.cssText = "min-width: min(520px, 80vw); max-height: 70vh; overflow-y: auto;";

    this.summaryEl = contentEl.createDiv({ cls: "courier-excluded-folders-summary" });
    this.updateSummary();

    const tree = buildExcludedFolderTree([...this.existingFolderPaths()]);
    const treeEl = contentEl.createDiv({ cls: "courier-excluded-folders-tree" });
    if (tree.length === 0) {
      treeEl.createDiv({
        cls: "courier-excluded-folders-empty",
        text: t("dialog.excludedFolders.empty"),
      });
    }
    this.checkboxes.clear();
    for (const node of tree) this.renderNode(treeEl, node);

    if (this.missing.length > 0) this.renderMissing(contentEl);

    // Always present (hidden until a save fails), so the reason appears above the button
    // that failed instead of as a toast that outlives the dialog.
    this.errorEl = contentEl.createDiv({ cls: "courier-setup-error" });
    this.showError(this.error);

    const footer = contentEl.createDiv({ cls: "courier-excluded-folders-footer" });
    const done = footer.createEl("button", {
      text: t("dialog.excludedFolders.done"),
      cls: "mod-cta courier-excluded-folders-done",
    });
    done.addEventListener("click", () => void this.apply());
  }

  /** One folder row, with its children in a container the disclosure arrow toggles. */
  private renderNode(parentEl: HTMLElement, node: ExcludedFolderNode): void {
    const nodeEl = parentEl.createDiv({ cls: "courier-excluded-folder-node" });
    const row = nodeEl.createDiv({ cls: "courier-excluded-folder-row" });
    row.style.paddingLeft = `${node.depth * 20 + 4}px`;

    let childrenEl: HTMLElement | null = null;
    if (node.children.length > 0) {
      const collapsed = this.collapsed.has(node.path);
      const toggle = row.createSpan({ cls: "courier-excluded-folder-toggle" });
      setIcon(toggle, collapsed ? "chevron-right" : "chevron-down");
      toggle.addEventListener("click", () => {
        if (this.collapsed.has(node.path)) this.collapsed.delete(node.path);
        else this.collapsed.add(node.path);
        const isCollapsed = this.collapsed.has(node.path);
        setIcon(toggle, isCollapsed ? "chevron-right" : "chevron-down");
        if (childrenEl) childrenEl.style.display = isCollapsed ? "none" : "";
      });
    } else {
      row.createSpan({ cls: "courier-excluded-folder-spacer" });
    }

    const checkbox = row.createEl("input", { cls: "courier-excluded-folder-checkbox" });
    checkbox.type = "checkbox";
    checkbox.checked = isFolderCoveredByExclusion(node.path, this.selected);
    checkbox.disabled = hasExcludedAncestor(node.path, this.selected);
    checkbox.addEventListener("change", () => {
      this.selected = toggleExcludedFolder(this.selected, node.path, checkbox.checked);
      this.syncCheckboxes();
    });
    this.checkboxes.set(node.path, checkbox);

    // Clicking the name/icon (the natural target) toggles too. The checkbox and the
    // disclosure arrow own their clicks; they return before this runs.
    row.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | undefined;
      if (target && (target === checkbox || target.closest?.(".courier-excluded-folder-toggle"))) {
        return;
      }
      if (checkbox.disabled) return;
      checkbox.checked = !checkbox.checked;
      this.selected = toggleExcludedFolder(this.selected, node.path, checkbox.checked);
      this.syncCheckboxes();
    });

    const icon = row.createSpan({ cls: "courier-excluded-folder-icon" });
    setIcon(icon, "folder");

    row.createSpan({ text: node.name, cls: "courier-excluded-folder-name" });

    if (node.children.length > 0) {
      childrenEl = nodeEl.createDiv({ cls: "courier-excluded-folder-children" });
      if (this.collapsed.has(node.path)) childrenEl.style.display = "none";
      for (const child of node.children) this.renderNode(childrenEl, child);
    }
  }

  /**
   * The exclusions whose folder no longer exists.
   *
   * Not part of the live tree: a checkbox there would claim a folder that is not in the
   * vault. The section keeps the rule visible (and removable) without suggesting the
   * folder exists. A folder recreated at the same path returns to the tree, still checked.
   */
  private renderMissing(parentEl: HTMLElement): void {
    const section = parentEl.createDiv({ cls: "courier-excluded-folders-missing" });
    section.createDiv({
      cls: "courier-excluded-folders-missing-title",
      text: t("dialog.excludedFolders.missingTitle"),
    });
    section.createDiv({
      cls: "courier-excluded-folders-missing-hint",
      text: t("dialog.excludedFolders.missingHint"),
    });

    for (const folder of this.missing) {
      const row = section.createDiv({
        cls: "courier-excluded-folder-row is-missing",
      });
      const icon = row.createSpan({ cls: "courier-excluded-folder-icon" });
      setIcon(icon, "folder");
      row.createSpan({ text: folder, cls: "courier-excluded-folder-name" });
      const remove = row.createEl("button", {
        text: t("dialog.excludedFolders.stopExcluding"),
        cls: "courier-excluded-folders-missing-remove",
      });
      remove.addEventListener("click", () => {
        this.missing = this.missing.filter((entry) => entry !== folder);
        row.detach();
        this.updateSummary();
        if (this.missing.length === 0) section.detach();
      });
    }
  }

  /** Update every checkbox/summary after a selection change, without rebuilding rows. */
  private syncCheckboxes(): void {
    for (const [path, checkbox] of this.checkboxes) {
      checkbox.checked = isFolderCoveredByExclusion(path, this.selected);
      checkbox.disabled = hasExcludedAncestor(path, this.selected);
    }
    this.updateSummary();
  }

  private updateSummary(): void {
    const total = this.selected.length + this.missing.length;
    if (total === 0) {
      this.summaryEl.setText(t("dialog.excludedFolders.none"));
      return;
    }
    this.summaryEl.setText(
      this.missing.length === 0
        ? plural(
            "dialog.excludedFolders.summary.one",
            "dialog.excludedFolders.summary.other",
            total,
          )
        : t("dialog.excludedFolders.summaryWithMissing", {
            count: total,
            missing: this.missing.length,
          }),
    );
  }

  private async apply(): Promise<void> {
    // A retry starts from a clean slate: the previous reason is either fixed or replaced.
    this.showError(null);
    try {
      await this.host.apply([...this.selected, ...this.missing, ...this.untouched]);
      this.close();
    } catch (err) {
      // Keep the dialog open so the selection is not lost when the save fails, and say
      // why next to the button — the dialog is the surface the user is looking at.
      this.showError(
        t("dialog.excludedFolders.saveFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  /** Show, replace or clear the line under the tree (null = nothing to say). */
  private showError(message: string | null): void {
    this.error = message;
    this.errorEl.setText(message ?? "");
    if (message === null) this.errorEl.removeClass("is-visible");
    else this.errorEl.addClass("is-visible");
  }
}

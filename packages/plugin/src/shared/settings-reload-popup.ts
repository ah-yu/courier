import {
  reloadPopupDismiss,
  reloadPopupMessage,
  reloadPopupReload,
  reloadPopupTitle,
} from "./settings-reload";

/**
 * The class the card carries, so a test (and any future stylesheet) can find it.
 * `sync.obsidian.test.ts` reads it out of a real Obsidian's DOM.
 */
export const RELOAD_POPUP_CLASS = "courier-reload-notice";

export interface ReloadPopupOptions {
  /**
   * Where the card is attached — Obsidian's workspace container.
   *
   * That element rather than `document.body`: it is the one always-present anchor the
   * plugin already holds, and it keeps this module free of global DOM access, which is
   * what lets the plugin tests drive it with the fake elements the harness hands over.
   */
  parent: HTMLElement;
  /** Run the reload. Answers whether Obsidian accepted the command. */
  onReload: () => boolean;
  /** The command was not available — say what to do instead of doing nothing. */
  onReloadUnavailable: () => void;
  /**
   * Draw the status icon inside the tile the card reserves for it.
   *
   * Injected rather than imported: `obsidian` ships types only, and this module is
   * exercised by the plugin's plain unit tests. `main.ts` passes Obsidian's
   * `setIcon`, which is also what keeps the icon in the app's own icon set.
   */
  renderIcon?: (host: HTMLElement) => void;
}

export interface ReloadPopup {
  /** Put the card up, or do nothing while it is already up. */
  show(): void;
  /** Whether the card is on screen right now. */
  isOpen(): boolean;
  /** Take it down (plugin unload). */
  destroy(): void;
}

/**
 * The "settings arrived — reload to see them" card: bottom-right on desktop, a bottom
 * sheet above the app's mobile chrome on a phone, one at a time, and it waits for the user.
 *
 * Deliberately **not** Obsidian's `Notice`. Two reasons, both measured against 1.14.4:
 * its container is anchored `top: 22px; right: 0` (the top-right corner, not the
 * bottom-right this feature was asked for), and a toast is the wrong shape for something
 * that carries a decision — the message is a title, a sentence and two buttons.
 *
 * The card is an ordinary element inside the workspace container. Its layout lives in
 * `styles.css`, keyed on this module's classes, so the phone rules can move it above
 * Obsidian's floating nav and on top of the safe-area inset; the colours are Obsidian's
 * own CSS variables, so it follows dark mode and custom themes. Nothing is injected into
 * the document head, and no layout is written as an inline style.
 *
 * Lifecycle is the whole feature: `show()` is a no-op while the card is up, so a peer
 * changing ten settings raises one card, and `destroy()` (the 稍后 button, the reload
 * button, a plugin unload) is what arms the next one.
 */
export function createReloadPopup(options: ReloadPopupOptions): ReloadPopup {
  let card: HTMLElement | null = null;

  const close = (): void => {
    card?.detach();
    card = null;
  };

  return {
    isOpen: () => card !== null,

    show() {
      if (card !== null) return;

      const element = options.parent.createDiv({ cls: RELOAD_POPUP_CLASS });
      // Record it while it is being filled: `renderIcon` is injected code, and the
      // `catch` below has to be able to take the element back out.
      card = element;
      try {
        if (options.renderIcon === undefined) element.addClass("courier-reload-notice-no-icon");
        // A status, not a dialog: the card is non-modal, never takes focus (the user may
        // be typing), and its arrival is what should be announced. `aria-live` makes that
        // announcement explicit; the buttons inside stay ordinary tab stops.
        element.setAttribute("role", "status");
        element.setAttribute("aria-label", reloadPopupTitle());
        element.setAttribute("aria-live", "polite");

        const head = element.createDiv({ cls: "courier-reload-notice-head" });
        if (options.renderIcon !== undefined) {
          const icon = head.createDiv({ cls: "courier-reload-notice-icon" });
          icon.setAttribute("aria-hidden", "true");
          options.renderIcon(icon);
        }
        head.createDiv({ cls: "courier-reload-notice-title", text: reloadPopupTitle() });

        element.createDiv({ cls: "courier-reload-notice-message", text: reloadPopupMessage() });

        const actions = element.createDiv({ cls: "courier-reload-notice-actions" });

        const later = actions.createEl("button", {
          cls: "courier-reload-notice-later",
          text: reloadPopupDismiss(),
        });
        later.addEventListener("click", close);

        const reload = actions.createEl("button", {
          cls: "courier-reload-notice-reload",
          text: reloadPopupReload(),
        });
        reload.addClass("mod-cta");
        reload.addEventListener("click", () => {
          close();
          if (!options.onReload()) options.onReloadUnavailable();
        });
      } catch (error) {
        // A card built halfway has no actions and nothing to say. Take it down and let
        // the caller see the failure, so the screen never holds a dead box and a later
        // `show()` is not a silent no-op.
        close();
        throw error;
      }
    },

    destroy: close,
  };
}

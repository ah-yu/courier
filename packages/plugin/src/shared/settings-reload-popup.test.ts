import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";
import { createReloadPopup, RELOAD_POPUP_CLASS } from "./settings-reload-popup";
import {
  reloadPopupDismiss,
  reloadPopupMessage,
  reloadPopupReload,
  reloadPopupTitle,
} from "./settings-reload";

beforeEach(() => setLocale("zh"));

/**
 * The smallest stand-in for the slice of Obsidian's extended DOM the card uses.
 *
 * Written here rather than imported from the e2e harness on purpose: the plugin package is
 * what the harness drives, so depending on it the other way round would tie the unit tests
 * to a fixture that exists to test *them*. Everything the card touches is in this interface,
 * which is also what keeps the card out of `document`.
 */
interface FakeNode {
  tagName: string;
  text: string;
  classes: string[];
  style: Record<string, string>;
  attributes: Record<string, string>;
  children: FakeNode[];
  listeners: Record<string, Array<() => void>>;
  parent?: FakeNode;
  createEl(tag: string, options?: { text?: string; cls?: string }): FakeNode;
  createDiv(options?: { text?: string; cls?: string }): FakeNode;
  addClass(cls: string): FakeNode;
  addEventListener(type: string, cb: () => void): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  detach(): void;
  click(): void;
}

function fakeNode(tagName = "div"): FakeNode {
  const node: FakeNode = {
    tagName,
    text: "",
    classes: [],
    style: {},
    attributes: {},
    children: [],
    listeners: {},
    createEl(tag, options) {
      const child = fakeNode(tag);
      child.text = options?.text ?? "";
      for (const cls of (options?.cls ?? "").split(/\s+/)) {
        if (cls) child.classes.push(cls);
      }
      child.parent = node;
      node.children.push(child);
      return child;
    },
    createDiv(options) {
      return node.createEl("div", options);
    },
    addClass(cls) {
      node.classes.push(cls);
      return node;
    },
    addEventListener(type, cb) {
      (node.listeners[type] ??= []).push(cb);
    },
    setAttribute(name, value) {
      node.attributes[name] = value;
    },
    getAttribute(name) {
      return node.attributes[name] ?? null;
    },
    detach() {
      const parent = node.parent;
      if (parent) parent.children = parent.children.filter((child) => child !== node);
    },
    click() {
      for (const cb of node.listeners.click ?? []) cb();
    },
  };
  return node;
}

/** The first descendant carrying a class, the root included. */
function findByClass(root: FakeNode, cls: string): FakeNode | undefined {
  if (root.classes.includes(cls)) return root;
  for (const child of root.children) {
    const found = findByClass(child, cls);
    if (found) return found;
  }
  return undefined;
}

/** Every button under a root, so a nested action still reads as one of the card's. */
function buttonsIn(root: FakeNode): FakeNode[] {
  const buttons: FakeNode[] = [];
  const walk = (node: FakeNode): void => {
    if (node.tagName === "button") buttons.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return buttons;
}

/** The card's own element, as it hangs off the parent. */
function cardOf(parent: FakeNode): FakeNode | undefined {
  return parent.children.find((child) => child.classes.includes(RELOAD_POPUP_CLASS));
}

/** The two buttons, by the labels the user reads. */
function buttonOf(card: FakeNode, label: string): FakeNode | undefined {
  return buttonsIn(card).find((button) => button.text === label);
}

describe("createReloadPopup", () => {
  const parent = (): FakeNode => fakeNode();

  it("builds the card's hierarchy: status icon, title, sentence and two actions", () => {
    const root = parent();
    const renderIcon = vi.fn((host: FakeNode) => host.addClass("drawn"));
    const popup = createReloadPopup({
      parent: root as unknown as HTMLElement,
      onReload: () => true,
      onReloadUnavailable: () => {},
      renderIcon: renderIcon as unknown as (host: HTMLElement) => void,
    });

    popup.show();

    const card = cardOf(root);
    expect(card, "no card was created").toBeDefined();
    expect(findByClass(card!, "courier-reload-notice-head")).toBeDefined();
    expect(findByClass(card!, "courier-reload-notice-title")!.text).toBe(reloadPopupTitle());
    expect(findByClass(card!, "courier-reload-notice-message")!.text).toBe(reloadPopupMessage());

    const icon = findByClass(card!, "courier-reload-notice-icon");
    expect(icon, "the card did not reserve a tile for its icon").toBeDefined();
    expect(card!.classes).not.toContain("courier-reload-notice-no-icon");
    expect(renderIcon).toHaveBeenCalledTimes(1);
    // `icon` is only known to be defined by the assertion above; `bun:test`'s
    // `toBe` does not narrow through `toBeDefined()`.
    expect(renderIcon.mock.calls[0]![0]).toBe(icon!);

    expect(buttonOf(card!, reloadPopupDismiss())!.classes).toContain("courier-reload-notice-later");
    expect(buttonOf(card!, reloadPopupReload())!.classes).toContain("mod-cta");
    expect(buttonOf(card!, reloadPopupReload())!.classes).toContain("courier-reload-notice-reload");
  });

  it("leaves positioning to the stylesheet and names itself to assistive technology", () => {
    const root = parent();
    const popup = createReloadPopup({
      parent: root as unknown as HTMLElement,
      onReload: () => true,
      onReloadUnavailable: () => {},
    });

    popup.show();

    const card = cardOf(root)!;
    // The phone rules select on the class and move the card above the mobile nav; an
    // inline `position`/`right`/`bottom` would win over every media query.
    expect(card.style.position).toBeUndefined();
    // A status, not a dialog: it never takes focus, so `role="dialog"` would promise
    // focus management this card deliberately does not do.
    expect(card.getAttribute("role")).toBe("status");
    expect(card.getAttribute("aria-modal")).toBeNull();
    expect(card.getAttribute("aria-label")).toBe(reloadPopupTitle());
    expect(card.getAttribute("aria-live")).toBe("polite");
  });

  it("still renders without an icon renderer, so the card is not tied to Obsidian", () => {
    const root = parent();
    const popup = createReloadPopup({
      parent: root as unknown as HTMLElement,
      onReload: () => true,
      onReloadUnavailable: () => {},
    });

    popup.show();

    const card = cardOf(root)!;
    expect(findByClass(card, "courier-reload-notice-icon")).toBeUndefined();
    expect(card.classes).toContain("courier-reload-notice-no-icon");
    expect(findByClass(card, "courier-reload-notice-title")!.text).toBe(reloadPopupTitle());
    expect(buttonOf(card, reloadPopupReload())).toBeDefined();
  });

  it("takes a half-built card back down when the icon renderer throws, so a later show can build", () => {
    // `renderIcon` is injected code. A throw is a bug, not a state to hide, but the card
    // must not be left on screen without its actions — and it must not make every later
    // `show()` a no-op.
    const root = parent();
    let attempts = 0;
    const popup = createReloadPopup({
      parent: root as unknown as HTMLElement,
      onReload: () => true,
      onReloadUnavailable: () => {},
      renderIcon: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("no icon set");
      },
    });

    expect(() => popup.show()).toThrow("no icon set");
    expect(popup.isOpen()).toBe(false);
    expect(cardOf(root)).toBeUndefined();

    popup.show();

    expect(popup.isOpen()).toBe(true);
    expect(findByClass(cardOf(root)!, "courier-reload-notice-icon")).toBeDefined();
    expect(findByClass(cardOf(root)!, "courier-reload-notice-title")!.text).toBe(
      reloadPopupTitle(),
    );
  });

  it("never names a file", () => {
    // The change came from a peer; which path it was is the sync history's job, and a name
    // invites the reading that the rest of the change did not arrive.
    expect(reloadPopupMessage()).not.toMatch(/\.json|\.css|\.obsidian|plugins\//);
  });

  it("shows one card however many changes arrive while it is up", () => {
    const root = parent();
    const popup = createReloadPopup({
      parent: root as unknown as HTMLElement,
      onReload: () => true,
      onReloadUnavailable: () => {},
    });

    popup.show();
    popup.show();
    popup.show();

    expect(
      root.children.filter((child) => child.classes.includes(RELOAD_POPUP_CLASS)),
    ).toHaveLength(1);
    expect(popup.isOpen()).toBe(true);
  });

  it("arms the next card when the user closes this one without reloading", () => {
    const root = parent();
    const onReload = vi.fn(() => true);
    const popup = createReloadPopup({
      parent: root as unknown as HTMLElement,
      onReload,
      onReloadUnavailable: () => {},
    });

    popup.show();
    buttonOf(cardOf(root)!, reloadPopupDismiss())!.click();

    expect(cardOf(root)).toBeUndefined();
    expect(popup.isOpen()).toBe(false);
    // Dismissing is not reloading — the card must not have asked for one.
    expect(onReload).not.toHaveBeenCalled();

    popup.show();
    expect(cardOf(root)).toBeDefined();
  });

  it("reloads on the primary button, and closes first so the card cannot outlive the app", () => {
    const root = parent();
    const order: string[] = [];
    const popup = createReloadPopup({
      parent: root as unknown as HTMLElement,
      onReload: () => {
        order.push(cardOf(root) === undefined ? "closed" : "open");
        return true;
      },
      onReloadUnavailable: () => {},
    });

    popup.show();
    buttonOf(cardOf(root)!, reloadPopupReload())!.click();

    expect(order).toEqual(["closed"]);
    expect(popup.isOpen()).toBe(false);
  });

  it("says so when the build cannot run the reload command", () => {
    const root = parent();
    const onReloadUnavailable = vi.fn();
    const popup = createReloadPopup({
      parent: root as unknown as HTMLElement,
      onReload: () => false,
      onReloadUnavailable,
    });

    popup.show();
    buttonOf(cardOf(root)!, reloadPopupReload())!.click();

    expect(onReloadUnavailable).toHaveBeenCalledTimes(1);
    expect(popup.isOpen()).toBe(false);
  });

  it("takes the card down on unload", () => {
    const root = parent();
    const popup = createReloadPopup({
      parent: root as unknown as HTMLElement,
      onReload: () => true,
      onReloadUnavailable: () => {},
    });

    popup.show();
    popup.destroy();

    expect(cardOf(root)).toBeUndefined();
    expect(popup.isOpen()).toBe(false);
  });
});

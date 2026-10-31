import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBurstNotifier } from "./notices";

/**
 * The burst notifier is what keeps a folder of conflicts — or a pass that keeps meeting
 * the same over-cap file — from becoming a wall of toasts. These tests pin the two
 * behaviours the plugin relies on: one line per window, and one line per identity for the
 * whole session.
 */
describe("createBurstNotifier", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a burst as one line once the window closes", () => {
    const emitted: string[] = [];
    const notifier = createBurstNotifier<number>({
      windowMs: 1000,
      render: (events) => `saw ${events.length}`,
      emit: (text) => emitted.push(text),
    });

    notifier.push(1);
    notifier.push(2);
    notifier.push(3);
    expect(emitted).toEqual([]);

    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual(["saw 3"]);
  });

  it("says nothing when the renderer returns null", () => {
    const emitted: string[] = [];
    const notifier = createBurstNotifier<number>({
      windowMs: 1000,
      render: () => null,
      emit: (text) => emitted.push(text),
    });

    notifier.push(1);
    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual([]);
  });

  it("drops an event whose identity was already announced, across windows", () => {
    const emitted: string[] = [];
    const notifier = createBurstNotifier<{ path: string }>({
      windowMs: 1000,
      render: (events) => `over cap: ${events.map((event) => event.path).join(",")}`,
      emit: (text) => emitted.push(text),
      keyOf: (event) => event.path,
    });

    notifier.push({ path: "video.mp4" });
    vi.advanceTimersByTime(1000);
    // The next pass meets the same file again: it is the same fact, not news.
    notifier.push({ path: "video.mp4" });
    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual(["over cap: video.mp4"]);

    // A different file in the same session is still reported.
    notifier.push({ path: "other.mp4" });
    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual(["over cap: video.mp4", "over cap: other.mp4"]);
  });

  it("names an identity once inside one window", () => {
    const emitted: string[] = [];
    const notifier = createBurstNotifier<string>({
      windowMs: 1000,
      render: (events) => events.join(","),
      emit: (text) => emitted.push(text),
      keyOf: (event) => event,
    });

    notifier.push("a");
    notifier.push("a");
    notifier.push("b");
    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual(["a,b"]);
  });

  it("does not consume an identity before a line was emitted", () => {
    const emitted: string[] = [];
    let saySomething = false;
    const notifier = createBurstNotifier<string>({
      windowMs: 1000,
      render: (events) => (saySomething ? events.join(",") : null),
      emit: (text) => emitted.push(text),
      keyOf: (event) => event,
    });

    // A burst that renders nothing says nothing, and the identity stays available.
    notifier.push("a");
    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual([]);

    saySomething = true;
    notifier.push("a");
    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual(["a"]);
  });

  it("cancels the pending line on reset without silencing the identity", () => {
    const emitted: string[] = [];
    const notifier = createBurstNotifier<string>({
      windowMs: 1000,
      render: (events) => events.join(","),
      emit: (text) => emitted.push(text),
      keyOf: (event) => event,
    });

    notifier.push("a");
    // Unload before the window closes: nothing is said for a session that ended, and
    // nothing was announced — so a later push is not treated as a repeat.
    notifier.reset();
    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual([]);

    notifier.push("a");
    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual(["a"]);
  });

  it("keeps announced identities across reset", () => {
    const emitted: string[] = [];
    const notifier = createBurstNotifier<string>({
      windowMs: 1000,
      render: (events) => events.join(","),
      emit: (text) => emitted.push(text),
      keyOf: (event) => event,
    });

    notifier.push("a");
    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual(["a"]);

    // Already announced in this session: a later burst does not repeat it.
    notifier.reset();
    notifier.push("a");
    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual(["a"]);
  });
});

import { describe, expect, it } from "vitest";
import { realPlatform } from "@courier/testing";
import {
  DEFAULT_RATE_LIMIT_WAIT_MS,
  MAX_RATE_LIMIT_WAIT_MS,
  isRateLimitError,
  rateLimitWaitMs,
  sleep,
} from "./rate-limit";

describe("isRateLimitError", () => {
  it("recognizes the server's 429 by status", () => {
    expect(isRateLimitError(Object.assign(new Error("nope"), { status: 429 }))).toBe(true);
  });

  it("recognizes it by code when a host re-wraps the error", () => {
    expect(isRateLimitError({ code: "RATE_LIMITED" })).toBe(true);
  });

  it("leaves every other failure alone", () => {
    expect(isRateLimitError(new Error("offline"))).toBe(false);
    expect(isRateLimitError(Object.assign(new Error("stale"), { status: 409 }))).toBe(false);
    expect(isRateLimitError({ code: "VALIDATION_ERROR" })).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError("RATE_LIMITED")).toBe(false);
  });
});

describe("rateLimitWaitMs", () => {
  it("uses the wait the server asked for", () => {
    expect(rateLimitWaitMs({ status: 429, retryAfterMs: 30_000 })).toBe(30_000);
  });

  it("rounds a fractional wait up, and never below the floor", () => {
    expect(rateLimitWaitMs({ status: 429, retryAfterMs: 1200.4 })).toBe(1201);
    expect(rateLimitWaitMs({ status: 429, retryAfterMs: 1 })).toBe(50);
  });

  it("caps an absurd wait", () => {
    expect(rateLimitWaitMs({ status: 429, retryAfterMs: 24 * 60 * 60_000 })).toBe(
      MAX_RATE_LIMIT_WAIT_MS,
    );
  });

  it("falls back to a whole window when the server did not say", () => {
    expect(rateLimitWaitMs({ status: 429 })).toBe(DEFAULT_RATE_LIMIT_WAIT_MS);
    expect(rateLimitWaitMs({ status: 429, retryAfterMs: 0 })).toBe(DEFAULT_RATE_LIMIT_WAIT_MS);
    expect(rateLimitWaitMs({ status: 429, retryAfterMs: Number.NaN })).toBe(
      DEFAULT_RATE_LIMIT_WAIT_MS,
    );
  });

  it("answers the default for an error that is not an object", () => {
    expect(rateLimitWaitMs(null)).toBe(DEFAULT_RATE_LIMIT_WAIT_MS);
    expect(rateLimitWaitMs(undefined)).toBe(DEFAULT_RATE_LIMIT_WAIT_MS);
    expect(rateLimitWaitMs("RATE_LIMITED")).toBe(DEFAULT_RATE_LIMIT_WAIT_MS);
    expect(isRateLimitError(undefined)).toBe(false);
  });

  it("accepts only a positive finite number as the wait", () => {
    // The guard is three conditions, and each has its own way of being wrong: a string
    // "30000" (what JSON gives you), a negative, an infinite value, and a member that is
    // not a number at all must all fall back to the whole window rather than be coerced.
    for (const retryAfterMs of ["30000", -5, 0, Number.POSITIVE_INFINITY, true, null]) {
      expect(
        rateLimitWaitMs({ status: 429, retryAfterMs }),
        `retryAfterMs=${String(retryAfterMs)}`,
      ).toBe(DEFAULT_RATE_LIMIT_WAIT_MS);
    }
    // …and an object without the field at all is the same answer.
    expect(rateLimitWaitMs(Object.create(null))).toBe(DEFAULT_RATE_LIMIT_WAIT_MS);
  });

  it("compares the status as a number and the code exactly", () => {
    // The server sends `status: 429` (a number) and `code: "RATE_LIMITED"` (upper case).
    // A string "429" or a differently-cased code is not the same refusal, and treating it
    // as one would make the pass wait for something that is not a limiter window.
    expect(isRateLimitError({ status: "429" })).toBe(false);
    expect(isRateLimitError({ code: "rate_limited" })).toBe(false);
    expect(isRateLimitError({ status: 429, code: "RATE_LIMITED" })).toBe(true);
  });
});

describe("sleep", () => {
  it("resolves after the delay", async () => {
    const started = performance.now();
    await sleep(20, realPlatform);
    expect(performance.now() - started).toBeGreaterThanOrEqual(10);
  });
});

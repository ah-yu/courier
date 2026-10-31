import { describe, expect, it } from "vitest";
import { withTimeout } from "./with-timeout";

describe("withTimeout", () => {
  it("passes through a value that settles in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 50)).resolves.toBe("ok");
  });

  it("passes through the original rejection", async () => {
    await expect(withTimeout(Promise.reject(new Error("refused")), 50)).rejects.toThrow("refused");
  });

  it("rejects when the promise never settles", async () => {
    await expect(withTimeout(new Promise(() => {}), 1)).rejects.toThrow("Timed out after 1 ms");
  });
});

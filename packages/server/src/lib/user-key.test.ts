import { describe, expect, it } from "vitest";
import { maskUserKey } from "./user-key";

describe("maskUserKey", () => {
  it("keeps the prefix and the ends of a real key", () => {
    const key = "ck_abcdefghijklmnopqrstuvwxyz0123456789";
    const masked = maskUserKey(key);

    expect(masked).toBe("ck_abcd****6789");
    expect(masked).not.toBe(key);
    expect(masked).not.toContain("efghijklmnopqrstuvwxyz012345");
  });

  it("masks a short key without splitting it in the middle", () => {
    expect(maskUserKey("ck_secret")).toBe("ck_s****t");
  });

  it("leaves an empty key empty rather than inventing a mask", () => {
    expect(maskUserKey("")).toBe("");
  });
});

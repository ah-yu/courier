import { beforeEach, describe, expect, it } from "vitest";
import { ApiClientError } from "@courier/shared";
import { setLocale } from "../i18n";
import { describeActionError, looksLikeUserKey, normalizeServerUrl } from "./action-error";

beforeEach(() => setLocale("zh"));

/**
 * The settings page shows these strings verbatim, and the login/vault steps rely
 * on the client-side checks to fail before a request is made. Pinned here so the
 * wording and the branches stay put without a DOM.
 */

describe("normalizeServerUrl", () => {
  it("trims and drops trailing slashes", () => {
    expect(normalizeServerUrl("  http://localhost:3002/  ")).toEqual({
      ok: true,
      url: "http://localhost:3002",
    });
    expect(normalizeServerUrl("https://vps.example.com///")).toEqual({
      ok: true,
      url: "https://vps.example.com",
    });
  });

  it("refuses an empty value, a missing scheme and a malformed URL", () => {
    expect(normalizeServerUrl("   ")).toEqual({
      ok: false,
      message: "请填写服务器地址，例如 http://localhost:3002。",
    });
    expect(normalizeServerUrl("vps.example.com:3002")).toEqual({
      ok: false,
      message: "服务器地址需要以 http:// 或 https:// 开头。",
    });
    expect(normalizeServerUrl("ftp://vps.example.com")).toEqual({
      ok: false,
      message: "服务器地址需要以 http:// 或 https:// 开头。",
    });
    expect(normalizeServerUrl("http://")).toEqual({
      ok: false,
      message: "服务器地址格式不正确，请检查。",
    });
  });
});

describe("looksLikeUserKey", () => {
  it("accepts the ck_ prefix, ignoring surrounding whitespace", () => {
    expect(looksLikeUserKey("ck_abc123")).toBe(true);
    expect(looksLikeUserKey("  ck_abc123  ")).toBe(true);
  });

  it("rejects anything else, including an empty value", () => {
    expect(looksLikeUserKey("ak_host")).toBe(false);
    expect(looksLikeUserKey("abc123")).toBe(false);
    expect(looksLikeUserKey("")).toBe(false);
  });
});

describe("describeActionError", () => {
  it("explains an invalid or expired user key", () => {
    expect(
      describeActionError(new ApiClientError(401, "UNAUTHORIZED", "bad key"), "登录失败"),
    ).toBe("用户密钥无效或已过期，请检查服务器地址与密钥。");
  });

  it("names the expired-key case even though the server answers 403", () => {
    expect(describeActionError(new ApiClientError(403, "KEY_EXPIRED", "expired"), "登录失败")).toBe(
      "该用户密钥已过期，请联系服务器管理员。",
    );
  });

  it("reports a vault that is no longer there", () => {
    expect(describeActionError(new ApiClientError(404, "NOT_FOUND", "Vault"), "删除失败")).toBe(
      "服务器上找不到这个远程库（可能已被删除）。",
    );
  });

  it("explains a vault allowance that is used up", () => {
    expect(
      describeActionError(
        new ApiClientError(409, "VAULT_LIMIT_REACHED", "limit"),
        "创建远程库失败",
      ),
    ).toBe("这个账号可创建的远程库数量已用完，请联系服务器管理员调整额度。");
  });

  it("surfaces the field errors the server validated", () => {
    expect(
      describeActionError(
        new ApiClientError(422, "VALIDATION_ERROR", "Validation failed", [
          { field: "name", message: "name is required" },
          { field: "name", message: "name too long" },
        ]),
        "创建远程库失败",
      ),
    ).toBe("创建远程库失败：name is required；name too long");
    // No details attached: the message still carries the reason.
    expect(
      describeActionError(
        new ApiClientError(422, "VALIDATION_ERROR", "Validation failed"),
        "创建失败",
      ),
    ).toBe("创建失败：Validation failed");
  });

  it("names the action for any other server refusal", () => {
    expect(describeActionError(new ApiClientError(500, "INTERNAL_ERROR", "boom"), "创建失败")).toBe(
      "创建失败：boom",
    );
  });

  it("reads a transport failure as an unreachable server", () => {
    expect(describeActionError(new Error("net::ERR_CONNECTION_REFUSED"), "登录失败")).toBe(
      "无法连接服务器。请检查地址、网络，以及服务器是否已启动。",
    );
    expect(describeActionError("not an error", "登录失败")).toBe(
      "无法连接服务器。请检查地址、网络，以及服务器是否已启动。",
    );
  });
});

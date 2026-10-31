import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { describe, expect, it, vi } from "vitest";
import { checkoutSlug, e2eVaults, prepareVault, type PrepareVaultDeps } from "./vaults";

/**
 * `prepareVault` is the one place in the harness that can raise the developer's Obsidian:
 * opening a vault through `obsidian://open` focuses an existing window. These cases pin the
 * guard that keeps an already-open vault — the normal state of a warm L3 run — away from
 * that call, so a run can happen behind whatever the developer has in front.
 *
 * They also pin the folder check (a name that resolves to another checkout's vault has to
 * fail here, before a run spends minutes writing files nobody will read) and the naming
 * rule that keeps two checkouts' pairs apart.
 */

const VAULT = {
  name: "courier-e2e-a-checkout-a",
  path: "/checkout-a/.e2e-vaults/courier-e2e-a-checkout-a",
};

/** Real-shaped dependencies; a case overrides only what it is about. */
function deps(overrides: Partial<PrepareVaultDeps> = {}): PrepareVaultDeps {
  return {
    ensureRunning: vi.fn(async () => {}),
    isReachable: vi.fn(async () => true),
    openWindow: vi.fn(),
    vaultPath: vi.fn(async () => VAULT.path),
    enablePlugins: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("prepareVault", () => {
  it("never opens (and therefore never focuses) a vault that already has a window", async () => {
    const d = deps();

    await prepareVault(VAULT, 1_000, d);

    expect(d.ensureRunning).toHaveBeenCalledTimes(1);
    expect(d.openWindow).not.toHaveBeenCalled();
    expect(d.wait).not.toHaveBeenCalled();
    expect(d.enablePlugins).toHaveBeenCalledWith(VAULT.name);
  });

  it("opens a window only when the vault has none, then waits for it", async () => {
    const isReachable = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const d = deps({ isReachable });

    await prepareVault(VAULT, 5_000, d);

    expect(d.openWindow).toHaveBeenCalledTimes(1);
    expect(d.openWindow).toHaveBeenCalledWith(VAULT.name);
    expect(d.enablePlugins).toHaveBeenCalledWith(VAULT.name);
  });

  it("reports a vault that never becomes reachable", async () => {
    const d = deps({ isReachable: vi.fn(async () => false) });

    await expect(prepareVault(VAULT, 0, d)).rejects.toThrow(/never became reachable/);
    expect(d.openWindow).toHaveBeenCalledTimes(1);
    expect(d.enablePlugins).not.toHaveBeenCalled();
  });

  it("refuses a vault the app opened from another checkout", async () => {
    const d = deps({
      vaultPath: vi.fn(async () => "/checkout-b/.e2e-vaults/courier-e2e-a-checkout-a"),
    });

    await expect(prepareVault(VAULT, 1_000, d)).rejects.toThrow(/but this run owns/);
    expect(d.enablePlugins).not.toHaveBeenCalled();
  });

  it("accepts the same folder written with the other separator", async () => {
    const d = deps({ vaultPath: vi.fn(async () => VAULT.path.replace(/\//g, "\\")) });

    await expect(prepareVault(VAULT, 1_000, d)).resolves.toBeUndefined();
    expect(d.enablePlugins).toHaveBeenCalledWith(VAULT.name);
  });

  // The inverse `skipIf` says the same thing as a Windows-only `runIf`.
  it.skipIf(process.platform !== "win32")(
    "accepts a differently cased path on Windows",
    async () => {
      const d = deps({ vaultPath: vi.fn(async () => VAULT.path.toUpperCase()) });

      await expect(prepareVault(VAULT, 1_000, d)).resolves.toBeUndefined();
      expect(d.enablePlugins).toHaveBeenCalledWith(VAULT.name);
    },
  );
});

/** A throwaway checkout root; `.git` is a directory or a file, as in the two layouts. */
function checkout(prefix: string, dotGit: "dir" | "file"): string {
  const root = mkdtempSync(join(tmpdir(), `courier-slug-${prefix}-`));
  if (dotGit === "dir") mkdirSync(join(root, ".git"));
  else writeFileSync(join(root, ".git"), "gitdir: /somewhere/else\n");
  return root;
}

/**
 * The naming rule is what lets two worktrees run L3 at the same time: Obsidian resolves a
 * vault by **name**, so the pair has to differ per checkout. Getting this wrong is silent —
 * both runs pass until they happen to touch the same folder.
 */
describe("checkoutSlug", () => {
  it("names the primary checkout after its directory too", () => {
    const root = checkout("primary", "dir");
    try {
      expect(checkoutSlug(root)).toBe(basename(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names a linked worktree after its directory, sanitized for a vault name", () => {
    const root = checkout("worktree", "file");
    try {
      expect(checkoutSlug(root)).toBe(basename(root));
      const spaced = join(root, "my worktree.v2");
      mkdirSync(spaced);
      writeFileSync(join(spaced, ".git"), "gitdir: /x\n");
      expect(checkoutSlug(spaced)).toBe("my-worktree.v2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the env overrides in charge of the vault names", () => {
    const previous = { a: process.env.COURIER_E2E_VAULT_A, b: process.env.COURIER_E2E_VAULT_B };
    try {
      process.env.COURIER_E2E_VAULT_A = "custom-a";
      process.env.COURIER_E2E_VAULT_B = "custom-b";
      const [a, b] = e2eVaults();
      expect(a.name).toBe("custom-a");
      expect(b.name).toBe("custom-b");
      expect(a.path.endsWith("custom-a")).toBe(true);
    } finally {
      if (previous.a === undefined) delete process.env.COURIER_E2E_VAULT_A;
      else process.env.COURIER_E2E_VAULT_A = previous.a;
      if (previous.b === undefined) delete process.env.COURIER_E2E_VAULT_B;
      else process.env.COURIER_E2E_VAULT_B = previous.b;
    }
  });
});

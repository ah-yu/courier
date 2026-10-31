import { describe, expect, it } from "vitest";
import { isBundledPath, resolveDataDir } from "./config";

/**
 * A compiled binary's `data/` directory.
 *
 * `bun build --compile` reports `import.meta.dir` as a path inside its virtual
 * filesystem, and the runtime says that directory *exists* — while any write into it
 * never reaches the disk. The deployment step that runs `courier migrate` then finds no
 * `data/courier.db` and fails with "the migration finished, but the database is not
 * there", which is exactly what happened on the first Bun-built release.
 */
/** `existsSync` that always answers yes — the virtual directory reports exactly that. */
function alwaysExists(): boolean {
  return true;
}

describe("the production data directory", () => {
  it("rejects the Linux virtual root even though it reports as existing", () => {
    expect(resolveDataDir("/$bunfs/root", "/home/u/courier/courier", alwaysExists)).toBe(
      "/home/u/courier",
    );
  });

  it("rejects the Windows virtual root", () => {
    expect(
      resolveDataDir("B:\\~BUN\\root", "C:\\Users\\u\\courier\\courier.exe", alwaysExists),
    ).toBe("C:\\Users\\u\\courier");
  });

  it("keeps a real directory that contains the module", () => {
    expect(resolveDataDir("/opt/courier/src", "/opt/courier/courier", alwaysExists)).toBe(
      "/opt/courier/src",
    );
  });

  it("falls back to the executable when the module directory is gone", () => {
    expect(resolveDataDir("/gone/src", "/opt/courier/courier", () => false)).toBe("/opt/courier");
  });

  it("recognises both bundled shapes", () => {
    expect(isBundledPath("/$bunfs/root")).toBe(true);
    expect(isBundledPath("B:\\~BUN\\root")).toBe(true);
    expect(isBundledPath("/home/u/courier")).toBe(false);
  });
});

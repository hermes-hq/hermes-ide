// Behavioural tests for ownDiskUsage (cow-usage.mjs), on real files: a copy
// holds all of its bytes, a copy-on-write clone none of them until it is
// written. Clones need a file system that makes them (APFS on macOS; the
// temp folder of a Linux runner usually cannot, so there only the copy is
// checked).
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, openSync, closeSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ownDiskUsage } from "./cow-usage.mjs";

const MB = 1024 * 1024;
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cow-usage-"));
  dirs.push(root);
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "blob.bin"), randomBytes(4 * MB));
  return { root, source };
}

/** Clone `from` to `to` (as N17's worktrees are cloned), or false when this file system cannot. */
function tryClone(from, to) {
  const args = platform() === "darwin" ? ["-c", from, to] : ["--reflink=always", from, to];
  return spawnSync("cp", args).status === 0;
}

describe.skipIf(platform() === "win32")("ownDiskUsage", { timeout: 30_000 }, () => {
  it("a plain copy holds every byte of its own", () => {
    const { root, source } = fixture();
    const copy = join(root, "copy");
    mkdirSync(copy);
    copyFileSync(join(source, "blob.bin"), join(copy, "blob.bin"));
    const u = ownDiskUsage(copy);
    expect(u.files).toBe(1);
    expect(u.bytes).toBe(4 * MB);
    expect(u.privateBytes).toBeGreaterThanOrEqual(4 * MB);
  });

  it("a clone holds nothing of its own until it is written, then only what was written", (ctx) => {
    const { root, source } = fixture();
    const clone = join(root, "clone");
    mkdirSync(clone);
    if (!tryClone(join(source, "blob.bin"), join(clone, "blob.bin"))) {
      if (platform() === "darwin") throw new Error("APFS must be able to clone in the temp folder");
      ctx.skip();
    }
    const before = ownDiskUsage(clone);
    expect(before.bytes).toBe(4 * MB);
    expect(before.privateBytes).toBeLessThan(64 * 1024);
    const fd = openSync(join(clone, "blob.bin"), "r+");
    writeSync(fd, Buffer.alloc(4096, 1), 0, 4096, 0);
    closeSync(fd);
    const after = ownDiskUsage(clone);
    expect(after.privateBytes).toBeGreaterThanOrEqual(4096);
    expect(after.privateBytes).toBeLessThan(MB);
  });

  it("counts every regular file under the folder", () => {
    const { source } = fixture();
    mkdirSync(join(source, "deep", "er"), { recursive: true });
    writeFileSync(join(source, "deep", "er", "a.txt"), "x".repeat(10_000));
    const u = ownDiskUsage(source);
    expect(u.files).toBe(2);
    expect(u.bytes).toBe(4 * MB + 10_000);
    expect(u.privateBytes).toBeGreaterThanOrEqual(4 * MB + 10_000);
  });
});

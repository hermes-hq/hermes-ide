// Behavioural tests for the build stamp: the hash follows the bundle and the
// checkout, the stamp is found in a binary even across read-chunk borders,
// and a running app with another stamp is reported as a mismatch.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STAMP_FILE,
  STAMP_PREFIX,
  binaryHasStamp,
  buildStamp,
  buildStampMismatch,
  hashTree,
  readBuildStamp,
} from "./build-stamp.mjs";

let work;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "hermes-stamp-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

function tree(name, files) {
  const dir = join(work, name);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

describe("hashTree", () => {
  it("gives the same hash for the same files and another for a changed byte", () => {
    const a = tree("a", { "index.html": "<html>", "assets/app.js": "console.log(1)" });
    const b = tree("b", { "index.html": "<html>", "assets/app.js": "console.log(1)" });
    const c = tree("c", { "index.html": "<html>", "assets/app.js": "console.log(2)" });
    expect(hashTree(a)).toBe(hashTree(b));
    expect(hashTree(a)).not.toBe(hashTree(c));
  });

  it("tells a renamed file from the original", () => {
    const a = tree("d", { "x.js": "same" });
    const b = tree("e", { "y.js": "same" });
    expect(hashTree(a)).not.toBe(hashTree(b));
  });
});

describe("buildStamp", () => {
  it("is stable for one checkout and bundle, and differs across checkouts and bundles", () => {
    const s = buildStamp({ repoRoot: "/work/checkout-1", distHash: "abc" });
    expect(s).toBe(buildStamp({ repoRoot: "/work/checkout-1", distHash: "abc" }));
    expect(s.startsWith(STAMP_PREFIX)).toBe(true);
    expect(s).not.toBe(buildStamp({ repoRoot: "/work/checkout-2", distHash: "abc" }));
    expect(s).not.toBe(buildStamp({ repoRoot: "/work/checkout-1", distHash: "abd" }));
  });
});

describe("binaryHasStamp", () => {
  const stamp = buildStamp({ repoRoot: "/work/x", distHash: "1" });

  it("finds the stamp anywhere in the file, including across a chunk border", () => {
    const filler = Buffer.alloc(1000, 0x41);
    const file = join(work, "bin-mid");
    // Chunk size 512: the stamp starts at byte 500 and straddles the border.
    writeFileSync(file, Buffer.concat([filler.subarray(0, 500), Buffer.from(stamp), filler]));
    expect(binaryHasStamp(file, stamp, { chunkSize: 512 })).toBe(true);
    expect(binaryHasStamp(file, stamp, { chunkSize: 7 })).toBe(true);
    expect(binaryHasStamp(file, stamp)).toBe(true);
  });

  it("is false for a binary built with another stamp, and for a missing file", () => {
    const other = buildStamp({ repoRoot: "/work/y", distHash: "1" });
    const file = join(work, "bin-other");
    writeFileSync(file, Buffer.concat([Buffer.alloc(300, 0x42), Buffer.from(other), Buffer.alloc(300, 0x42)]));
    expect(binaryHasStamp(file, stamp, { chunkSize: 64 })).toBe(false);
    expect(binaryHasStamp(join(work, "does-not-exist"), stamp)).toBe(false);
  });
});

describe("readBuildStamp / buildStampMismatch", () => {
  it("reads what build.mjs wrote and accepts an app reporting the same stamp", () => {
    const bin = join(work, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, STAMP_FILE), JSON.stringify({ stamp: "hermes-e2e-build-aaaa", distHash: "d" }));
    const expected = readBuildStamp(bin);
    expect(expected.stamp).toBe("hermes-e2e-build-aaaa");
    expect(buildStampMismatch({ build: "hermes-e2e-build-aaaa" }, expected)).toBeNull();
  });

  it("names both stamps when the running app was built elsewhere", () => {
    const expected = { stamp: "hermes-e2e-build-aaaa" };
    expect(buildStampMismatch({ build: "hermes-e2e-build-bbbb" }, expected)).toMatch(/hermes-e2e-build-bbbb.*hermes-e2e-build-aaaa/);
    expect(buildStampMismatch({ build: null }, expected)).toMatch(/no build stamp/);
    expect(buildStampMismatch({}, expected)).toMatch(/no build stamp/);
  });

  it("has nothing to compare when build.mjs recorded no stamp", () => {
    expect(readBuildStamp(join(work, "no-such-bin"))).toBeNull();
    expect(buildStampMismatch({ build: "anything" }, null)).toBeNull();
  });
});

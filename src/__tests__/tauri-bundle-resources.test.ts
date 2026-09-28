/**
 * Smoke test for the Agent-mode shipping invariant: the installer must carry
 * the bridge and its npm runtime (v1.1.0 / v1.1.2 shipped without them and
 * every Agent session failed to spawn).
 *
 * Since ADR 002 the whole runtime (bridge scripts + node_modules) ships as
 * ONE packed archive in `bridge/runtime/`, written by
 * `scripts/pack-bridge-runtime.mjs` during `npm run prepare:bridge`. What
 * goes into the archive is tested by running the packer
 * (scripts/pack-bridge-runtime.test.mjs); unpacking it by the Rust tests in
 * src-tauri/src/agent/runtime.rs; the installed result by the release
 * smoke's self-test.
 */

import { readFileSync, existsSync } from "fs";
import { describe, it, expect } from "vitest";

const TAURI_CONF = "src-tauri/tauri.conf.json";

describe("tauri.conf.json bundle resources", () => {
  const conf = JSON.parse(readFileSync(TAURI_CONF, "utf-8"));
  const resources: string[] = conf?.bundle?.resources ?? [];

  it("ships the packed bridge runtime folder", () => {
    expect(resources).toContain("bridge/runtime");
  });

  it("no longer ships the raw node_modules tree (it broke the AppImage and added ~100 MB)", () => {
    expect(resources.some((r) => r.includes("node_modules"))).toBe(false);
  });

  it("every declared resource exists in a fresh checkout", () => {
    for (const r of resources) {
      expect(existsSync(`src-tauri/${r}`), `expected src-tauri/${r} to exist`).toBe(true);
    }
  });

  // A platform config replaces the whole resources array (JSON merge patch),
  // so each one that lists resources must carry the packed runtime too.
  for (const platform of ["linux", "windows"]) {
    it(`tauri.${platform}.conf.json ships the packed runtime, not node_modules`, () => {
      const file = `src-tauri/tauri.${platform}.conf.json`;
      const own: string[] = JSON.parse(readFileSync(file, "utf-8"))?.bundle?.resources ?? [];
      if (own.length === 0) return;
      expect(own).toContain("bridge/runtime");
      expect(own.some((r) => r.includes("node_modules"))).toBe(false);
    });
  }

  it("packs the runtime as part of beforeBuildCommand", () => {
    const cmd: string = conf?.build?.beforeBuildCommand ?? "";
    expect(cmd).toMatch(/prepare:bridge/);
    const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
    expect(pkg.scripts["prepare:bridge"]).toMatch(/pack-bridge-runtime\.mjs/);
  });
});

describe("bridge runtime package.json", () => {
  const root = JSON.parse(readFileSync("package.json", "utf-8"));
  const bridge = JSON.parse(
    readFileSync("src-tauri/bridge/package.json", "utf-8"),
  );

  it("pins the same Claude Agent SDK version as the root project", () => {
    const rootRange: string = root.dependencies["@anthropic-ai/claude-agent-sdk"];
    const bridgePin: string = bridge.dependencies["@anthropic-ai/claude-agent-sdk"];
    // Root uses a caret range (e.g. "^0.2.132"); the bridge pins the
    // exact base version so the bundled binary matches what is installed
    // in CI.  When you bump the SDK in root, also bump the bridge here.
    const rootBase = rootRange.replace(/^[\^~]/, "");
    expect(bridgePin).toBe(rootBase);
  });

  it("includes zod (peer dep of the SDK) so the bridge's `import { z } from 'zod'` resolves", () => {
    expect(bridge.dependencies?.zod).toBeTruthy();
  });
});

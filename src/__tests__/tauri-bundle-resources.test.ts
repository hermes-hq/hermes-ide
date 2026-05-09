/**
 * Smoke test for the Agent-mode shipping invariant:
 *   the Hermes bridge files MUST be declared as Tauri bundle resources,
 *   otherwise production .app builds ship without them and every Agent
 *   session silently fails to spawn (v1.1.0 regression).
 *
 * If this test fails, the CI bundle won't have `bridge/` under the
 * app's Resources/ directory and `resolve_bridge_path()` will return
 * an error to every spawn callsite.  Don't delete this without first
 * proving the bridge is shipped some other way (e.g., embedded).
 */

import { readFileSync, existsSync } from "fs";
import { describe, it, expect } from "vitest";

const TAURI_CONF = "src-tauri/tauri.conf.json";

describe("tauri.conf.json bundle resources", () => {
  const conf = JSON.parse(readFileSync(TAURI_CONF, "utf-8"));

  it("declares hermes-claude-bridge.mjs as a bundle resource", () => {
    const resources: string[] = conf?.bundle?.resources ?? [];
    expect(Array.isArray(resources)).toBe(true);
    const hasBridge = resources.some((r) =>
      r.includes("hermes-claude-bridge.mjs"),
    );
    expect(hasBridge).toBe(true);
  });

  it("declares canUseToolHelpers.mjs as a bundle resource", () => {
    const resources: string[] = conf?.bundle?.resources ?? [];
    const hasHelpers = resources.some((r) =>
      r.includes("canUseToolHelpers.mjs"),
    );
    expect(hasHelpers).toBe(true);
  });

  it("every declared bridge resource exists on disk", () => {
    const resources: string[] = conf?.bundle?.resources ?? [];
    for (const r of resources) {
      // Resources are expressed relative to src-tauri/.
      const onDisk = `src-tauri/${r}`;
      expect(existsSync(onDisk)).toBe(true);
    }
  });
});

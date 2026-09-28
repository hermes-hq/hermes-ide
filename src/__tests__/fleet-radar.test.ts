/**
 * F37 — Collision Radar v0: sessions whose latest turns touched the same
 * file in the same repository are marked, from the turn ledger.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeOverlaps, filesInPatch, RADAR_TURN_WINDOW } from "../fleet/radar";
import {
  _resetRadarForTest,
  getSessionOverlap,
  refreshSessionTurnFiles,
  setRadarSessions,
  setTurnSourceForTest,
  type TurnSource,
} from "../fleet/radarStore";
import type { Turn } from "../agent/contract/turns";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 111..222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,3 @@",
  "--- this removed line looks like a header",
  "+++ and so does this added one",
  " ok",
  "diff --git a/old name.md b/new name.md",
  "similarity index 90%",
  "rename from old name.md",
  "rename to new name.md",
  "diff --git a/gone.txt b/gone.txt",
  "deleted file mode 100644",
  "--- a/gone.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/img.png b/img.png",
  "Binary files a/img.png and b/img.png differ",
].join("\n");

describe("filesInPatch", () => {
  it("reads every changed path from a git diff, renames on both sides, never hunk lines", () => {
    expect(filesInPatch(PATCH).sort()).toEqual(["gone.txt", "img.png", "new name.md", "old name.md", "src/app.ts"]);
  });

  it("reads an added file and an empty patch", () => {
    expect(filesInPatch("diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+x")).toEqual(["n.ts"]);
    expect(filesInPatch("")).toEqual([]);
  });
});

describe("computeOverlaps", () => {
  const entry = (sessionId: string, files: string[], repoKeys = ["p1"]) => ({ sessionId, repoKeys, files: new Set(files) });

  it("marks both sessions that share a file, with the shared files", () => {
    const o = computeOverlaps([entry("a", ["src/x.ts", "README.md"]), entry("b", ["src/x.ts", "src/y.ts"]), entry("c", ["docs/z.md"])]);
    expect(o.get("a")?.others).toEqual([{ sessionId: "b", files: ["src/x.ts"] }]);
    expect(o.get("b")?.others).toEqual([{ sessionId: "a", files: ["src/x.ts"] }]);
    expect(o.has("c")).toBe(false);
  });

  it("does not compare files across different repositories", () => {
    expect(computeOverlaps([entry("a", ["src/x.ts"], ["p1"]), entry("b", ["src/x.ts"], ["p2"])]).size).toBe(0);
  });

  it("lists every session a file is shared with", () => {
    const o = computeOverlaps([entry("a", ["f"]), entry("b", ["f"]), entry("c", ["f"])]);
    expect(o.get("a")?.others.map((x) => x.sessionId)).toEqual(["b", "c"]);
  });
});

describe("the radar store over the turn ledger", () => {
  let ledger: Record<string, { n: number; patch?: string; paths?: string[]; ended?: boolean }[]>;
  const diffCalls: string[] = [];

  beforeEach(() => {
    _resetRadarForTest();
    diffCalls.length = 0;
    ledger = {};
    const turn = (sessionId: string, t: { n: number; paths?: string[]; ended?: boolean }): Turn => ({
      sessionId,
      n: t.n,
      ref: `refs/hermes/${sessionId}/turn/${t.n}`,
      startedAt: 1,
      endedAt: t.ended === false ? null : 2,
      diffstat: { files: 1, insertions: 1, deletions: 0 },
      ...(t.paths ? { paths: t.paths } : {}),
    });
    const source: TurnSource = {
      listTurns: async (id) => (ledger[id] ?? []).map((t) => turn(id, t)),
      getTurnDiff: async (id, n) => {
        diffCalls.push(`${id}#${n}`);
        const t = (ledger[id] ?? []).find((x) => x.n === n);
        return t ? { turn: turn(id, t), patch: t.patch ?? "" } : null;
      },
    };
    setTurnSourceForTest(source);
    setRadarSessions(["a", "b", "c"], () => ["p1"]);
  });

  const patchFor = (...files: string[]) => files.map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-x\n+y`).join("\n");

  it("badges two sessions whose latest turns touched the same file, and not a third", async () => {
    ledger.a = [{ n: 1, patch: patchFor("src/login.ts") }];
    ledger.b = [{ n: 1, paths: ["src/login.ts", "src/api.ts"] }];
    ledger.c = [{ n: 1, patch: patchFor("docs/readme.md") }];
    await Promise.all(["a", "b", "c"].map(refreshSessionTurnFiles));
    expect(getSessionOverlap("a")?.others).toEqual([{ sessionId: "b", files: ["src/login.ts"] }]);
    expect(getSessionOverlap("b")?.others).toEqual([{ sessionId: "a", files: ["src/login.ts"] }]);
    expect(getSessionOverlap("c")).toBeNull();
  });

  it(`only the latest ${RADAR_TURN_WINDOW} turns count`, async () => {
    ledger.a = [
      { n: 1, patch: patchFor("old.ts") },
      { n: 2, patch: patchFor("x2.ts") },
      { n: 3, patch: patchFor("x3.ts") },
      { n: 4, patch: patchFor("x4.ts") },
    ];
    ledger.b = [{ n: 1, patch: patchFor("old.ts") }];
    await Promise.all([refreshSessionTurnFiles("a"), refreshSessionTurnFiles("b")]);
    expect(getSessionOverlap("a")).toBeNull();
    ledger.b.push({ n: 2, patch: patchFor("x4.ts") });
    await refreshSessionTurnFiles("b");
    expect(getSessionOverlap("a")?.others[0].files).toEqual(["x4.ts"]);
  });

  it("reads an ended turn's diff once, a running turn's every time", async () => {
    ledger.a = [{ n: 1, patch: patchFor("f.ts") }, { n: 2, patch: patchFor("g.ts"), ended: false }];
    await refreshSessionTurnFiles("a");
    await refreshSessionTurnFiles("a");
    expect(diffCalls.filter((c) => c === "a#1")).toHaveLength(1);
    expect(diffCalls.filter((c) => c === "a#2")).toHaveLength(2);
  });

  it("a closed session drops out of the radar", async () => {
    ledger.a = [{ n: 1, paths: ["f"] }];
    ledger.b = [{ n: 1, paths: ["f"] }];
    await Promise.all([refreshSessionTurnFiles("a"), refreshSessionTurnFiles("b")]);
    expect(getSessionOverlap("a")).not.toBeNull();
    setRadarSessions(["a"], () => ["p1"]);
    expect(getSessionOverlap("a")).toBeNull();
  });

  it("an empty ledger (F20 not filled yet) means no badge", async () => {
    setTurnSourceForTest(null); // the real seam, answering [] through the mocked invoke
    await refreshSessionTurnFiles("a");
    expect(getSessionOverlap("a")).toBeNull();
  });
});

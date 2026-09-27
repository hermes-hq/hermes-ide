// @vitest-environment jsdom
/**
 * Startup diet: work that only some people need is not done at launch.
 *   - the Claude agent bridge is warmed only once an Agent-view session exists
 *   - the first-launch wizard is only downloaded when it will be shown
 *   - the startup bundle budget check measures what the window must load
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const invoke = vi.fn((_cmd: string, _args?: unknown) => Promise.resolve(true));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

const getSetting = vi.fn<(key: string) => Promise<string | null>>();
vi.mock("../api/settings", () => ({
  getSetting: (key: string) => getSetting(key),
  setSetting: vi.fn(() => Promise.resolve()),
}));

const wizardModuleLoaded = vi.fn();
vi.mock("../components/OnboardingWizard", () => {
  wizardModuleLoaded();
  return { OnboardingWizard: () => <div>welcome wizard</div> };
});

import { useAgentBridgeWarmup } from "../hooks/useAgentBridgeWarmup";
import { OnboardingGate } from "../components/OnboardingGate";
import { lazyView, loadedViews } from "../utils/lazyView";
// @ts-expect-error — plain ESM script without type declarations
import { checkBudget, measureStartupJs, staticImports } from "../../scripts/bundle-budget.mjs";

afterEach(() => {
  cleanup();
  invoke.mockClear();
  getSetting.mockReset();
});

describe("agent bridge warm-up", () => {
  const warmCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === "warm_agent_bridge").length;

  it("is not requested while only terminal sessions exist", () => {
    renderHook(() => useAgentBridgeWarmup([{ mode: "terminal" }, { mode: "terminal" }]));
    expect(warmCalls()).toBe(0);
  });

  it("is requested once an Agent-view session appears, and not again on re-render", () => {
    const { rerender } = renderHook(({ sessions }) => useAgentBridgeWarmup(sessions), {
      initialProps: { sessions: [{ mode: "terminal" }] as { mode: string }[] },
    });
    expect(warmCalls()).toBe(0);

    rerender({ sessions: [{ mode: "terminal" }, { mode: "agent" }] });
    expect(warmCalls()).toBe(1);

    rerender({ sessions: [{ mode: "agent" }, { mode: "agent" }, { mode: "terminal" }] });
    expect(warmCalls()).toBe(1);
  });

  it("is requested at startup when a restored session is in Agent view", () => {
    renderHook(() => useAgentBridgeWarmup([{ mode: "agent" }]));
    expect(warmCalls()).toBe(1);
  });
});

describe("first-launch wizard gate", () => {
  it("does not load the wizard for someone who already finished it", async () => {
    getSetting.mockResolvedValue("true");
    wizardModuleLoaded.mockClear();
    render(<OnboardingGate />);
    await waitFor(() => expect(getSetting).toHaveBeenCalledWith("onboarding_completed"));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("welcome wizard")).toBeNull();
    expect(wizardModuleLoaded).not.toHaveBeenCalled();
  });

  it("loads and shows the wizard on first launch", async () => {
    getSetting.mockRejectedValue(new Error("no such setting"));
    render(<OnboardingGate />);
    expect(await screen.findByText("welcome wizard")).toBeTruthy();
  });
});

describe("on-demand views", () => {
  it("fetch their code only when first rendered, and are recorded as loaded then", async () => {
    const load = vi.fn(() => Promise.resolve(() => <p>late view</p>));
    const LateView = lazyView("LateView", load);
    expect(load).not.toHaveBeenCalled();
    expect(loadedViews()).not.toContain("LateView");

    render(
      <Suspense fallback={<p>loading</p>}>
        <LateView />
      </Suspense>,
    );
    expect(await screen.findByText("late view")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
    expect(loadedViews()).toContain("LateView");
  });
});

describe("startup bundle budget", () => {
  function fakeDist(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "bundle-budget-"));
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }

  const html = `<!doctype html><html><head>
    <script type="module" crossorigin src="/assets/index.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/runtime.js">
    <link rel="stylesheet" href="/assets/index.css">
  </head><body></body></html>`;

  it("counts the entry, preloads and their static imports, but not lazy chunks", () => {
    const dir = fakeDist({
      "index.html": html,
      "assets/index.js": `import{a as b}from"./shared.js";import"./side.js";const L=()=>import("./lazy.js");`,
      "assets/runtime.js": "r".repeat(100),
      "assets/shared.js": `export*from"./deep.js";` + "s".repeat(50),
      "assets/deep.js": "d".repeat(30),
      "assets/side.js": "e".repeat(20),
      "assets/lazy.js": "l".repeat(100_000),
      "assets/index.css": "c".repeat(100_000),
    });
    try {
      const { files, totalBytes } = measureStartupJs(dir);
      const names = files.map((f: { file: string }) => f.file.replace(/\\/g, "/")).sort();
      expect(names).toEqual(["assets/deep.js", "assets/index.js", "assets/runtime.js", "assets/shared.js", "assets/side.js"]);
      expect(totalBytes).toBeLessThan(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when the startup JS grows past the budget", () => {
    const dir = fakeDist({ "index.html": html, "assets/index.js": "x".repeat(2000), "assets/runtime.js": "" });
    try {
      expect(checkBudget(dir, { startupJsMaxBytes: 5000 }).ok).toBe(true);
      const over = checkBudget(dir, { startupJsMaxBytes: 1999 });
      expect(over.ok).toBe(false);
      expect(over.totalBytes).toBe(2000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("only follows static imports", () => {
    expect(staticImports(`import x from"./a.js";import("./b.js");export{y}from"../c.js";import"./d.js"`).sort()).toEqual([
      "../c.js",
      "./a.js",
      "./d.js",
    ]);
  });
});

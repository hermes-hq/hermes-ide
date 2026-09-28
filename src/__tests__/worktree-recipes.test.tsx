// @vitest-environment jsdom
/**
 * F26 — worktree recipes (frontend side).
 *
 * Drives runWorktreeRecipes with a fake backend and checks what a person
 * sees and what reaches the inbox:
 * - no .hermes/worktree.toml: nothing runs, nothing shows
 * - a file seen for the first time asks first; Skip runs nothing, Run setup
 *   runs it with the user's approval and the parsed commands
 * - a file approved before runs straight away
 * - a failed setup, a refused copy (the backend's message) and an unreadable
 *   file each raise one inbox error; a stop by the user does not
 * - done_when alone runs nothing but is kept for Done-When
 * - the panel shows the question, the log as it streams, and Close
 *
 * The backend (copy refusal, secrets masking, ports, killing a run) is
 * covered in src-tauri/src/git/recipe.rs; the whole journey on the real app
 * in e2e/app/scenarios/F26-worktree-recipes.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import {
  runWorktreeRecipes,
  decideRecipe,
  listRecipeRuns,
  appendRecipeLine,
  defaultDoneWhen,
  _resetWorktreeRecipesForTest,
  type RecipeDeps,
  type RecipeFileInfo,
  type RecipeOutcome,
  type RecipeRunRequest,
} from "../state/worktreeRecipes";
import type { InboxRaise } from "../agent/contract/inbox";
import { WorktreeRecipePanel } from "../components/WorktreeRecipePanel";
import { I18nProvider } from "../i18n/I18nProvider";

const SESSION = "sess-f26";
const WT = { projectId: "p1", branch: "hermes/task-abcd", worktreePath: "/srv/f26/data/hermes-worktrees/x/sess_task" };

const RECIPE = `
setup = ["node scripts/setup.js", "npm test -- --version"]
copy = [".env*"]
done_when = ["npm test"]

[ports]
web = 3000
`;

function file(text: string, trusted = false): RecipeFileInfo {
  return { origin: "worktree", text, hash: "abc123", trusted, projectName: "demo" };
}

const OK: RecipeOutcome = { ok: true, stopped: false, failure: null, copied: [".env"], ports: { web: 3000 } };

function fakeDeps(info: RecipeFileInfo | null, outcome: RecipeOutcome | Error = OK) {
  const runs: RecipeRunRequest[] = [];
  const raised: InboxRaise[] = [];
  const deps: RecipeDeps = {
    read: vi.fn(async () => info),
    run: vi.fn(async (req: RecipeRunRequest) => {
      runs.push(req);
      appendRecipeLine(req.runId, { stream: "command", text: "$ node scripts/setup.js" });
      appendRecipeLine(req.runId, { stream: "stdout", text: "installing" });
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
    raise: vi.fn((item: InboxRaise) => {
      raised.push(item);
    }),
    listenForLog: vi.fn(async () => {}),
  };
  return { deps, runs, raised };
}

/** Wait until the run is waiting for the user's answer. */
async function awaitingRun() {
  await waitFor(() => expect(listRecipeRuns()[0]?.state).toBe("awaiting"));
  return listRecipeRuns()[0];
}

beforeEach(() => {
  _resetWorktreeRecipesForTest();
});

afterEach(() => {
  cleanup();
});

describe("F26 runWorktreeRecipes", () => {
  it("does nothing when the repository has no worktree.toml", async () => {
    const { deps, raised } = fakeDeps(null);
    await runWorktreeRecipes(SESSION, [WT], deps);
    expect(deps.run).not.toHaveBeenCalled();
    expect(listRecipeRuns()).toEqual([]);
    expect(raised).toEqual([]);
  });

  it("asks before a file's commands run the first time; Skip runs nothing", async () => {
    const { deps, raised } = fakeDeps(file(RECIPE));
    const done = runWorktreeRecipes(SESSION, [WT], deps);
    const run = await awaitingRun();
    expect(run.setup).toEqual(["node scripts/setup.js", "npm test -- --version"]);
    expect(run.copy).toEqual([".env*"]);
    expect(deps.run).not.toHaveBeenCalled();
    decideRecipe(run.runId, "skip");
    await done;
    expect(deps.run).not.toHaveBeenCalled();
    expect(listRecipeRuns()[0].state).toBe("skipped");
    expect(raised).toEqual([]);
  });

  it("Run setup sends the approval, the parsed recipe and the file's hash", async () => {
    const { deps, runs, raised } = fakeDeps(file(RECIPE));
    const done = runWorktreeRecipes(SESSION, [WT], deps);
    decideRecipe((await awaitingRun()).runId, "run");
    await done;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      sessionId: SESSION,
      projectId: "p1",
      hash: "abc123",
      approve: true,
      copy: [".env*"],
      setup: ["node scripts/setup.js", "npm test -- --version"],
      ports: { web: 3000 },
    });
    const run = listRecipeRuns()[0];
    expect(run.state).toBe("succeeded");
    expect(run.ports).toEqual({ web: 3000 });
    expect(run.lines.map((l) => l.text)).toEqual(["$ node scripts/setup.js", "installing"]);
    expect(raised).toEqual([]);
    expect(defaultDoneWhen(SESSION)).toEqual(["npm test"]);
  });

  it("a file approved before runs without asking, and without re-approving", async () => {
    const { deps, runs } = fakeDeps(file(RECIPE, true));
    await runWorktreeRecipes(SESSION, [WT], deps);
    expect(runs).toHaveLength(1);
    expect(runs[0].approve).toBe(false);
    expect(listRecipeRuns()[0].state).toBe("succeeded");
  });

  it("a failed setup raises one inbox error for the session", async () => {
    const failed: RecipeOutcome = { ok: false, stopped: false, failure: "`npm ci` exited with code 1", copied: [], ports: {} };
    const { deps, raised } = fakeDeps(file(RECIPE, true), failed);
    await runWorktreeRecipes(SESSION, [WT], deps);
    expect(listRecipeRuns()[0].state).toBe("failed");
    expect(listRecipeRuns()[0].failure).toBe("`npm ci` exited with code 1");
    expect(raised).toEqual([
      { kind: "error", sessionId: SESSION, detail: "Setup failed in demo: `npm ci` exited with code 1", source: "worktree" },
    ]);
  });

  it("a refused copy is a failure with the backend's message", async () => {
    const refused: RecipeOutcome = {
      ok: false,
      stopped: false,
      failure: 'Refused copy ".env*": .env.example is tracked by git (copy only takes files git ignores)',
      copied: [],
      ports: {},
    };
    const { deps, raised } = fakeDeps(file(RECIPE, true), refused);
    await runWorktreeRecipes(SESSION, [WT], deps);
    expect(raised).toHaveLength(1);
    expect(raised[0].detail).toContain(".env.example is tracked by git");
  });

  it("a run the backend refuses (file changed) is a failure too", async () => {
    const { deps, raised } = fakeDeps(file(RECIPE, true), new Error(".hermes/worktree.toml changed since it was shown; nothing ran"));
    await runWorktreeRecipes(SESSION, [WT], deps);
    expect(listRecipeRuns()[0].state).toBe("failed");
    expect(raised[0].detail).toContain("changed since it was shown");
  });

  it("a stop by the user is not an error", async () => {
    const stopped: RecipeOutcome = { ok: false, stopped: true, failure: null, copied: [], ports: {} };
    const { deps, raised } = fakeDeps(file(RECIPE, true), stopped);
    await runWorktreeRecipes(SESSION, [WT], deps);
    expect(listRecipeRuns()[0].state).toBe("stopped");
    expect(raised).toEqual([]);
  });

  it("an unreadable file is shown with its line and raised, and nothing runs", async () => {
    const { deps, raised } = fakeDeps(file('setup = ["npm ci"]\ncopy = .env\n'));
    await runWorktreeRecipes(SESSION, [WT], deps);
    expect(deps.run).not.toHaveBeenCalled();
    const run = listRecipeRuns()[0];
    expect(run.state).toBe("invalid");
    expect(run.failure).toMatch(/^\.hermes\/worktree\.toml can't be read \(line 2\): /);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ kind: "error", sessionId: SESSION, source: "worktree" });
    expect(raised[0].detail).toContain("(line 2)");
  });

  it("done_when alone runs nothing and shows nothing, but is kept for the session", async () => {
    const { deps } = fakeDeps(file('done_when = ["npm test", "cargo test"]\n'));
    await runWorktreeRecipes(SESSION, [WT], deps);
    expect(deps.run).not.toHaveBeenCalled();
    expect(listRecipeRuns()).toEqual([]);
    expect(defaultDoneWhen(SESSION)).toEqual(["npm test", "cargo test"]);
    expect(defaultDoneWhen("other")).toEqual([]);
  });

  it("a backend that cannot even read the file never breaks session creation", async () => {
    const { deps } = fakeDeps(null);
    deps.read = vi.fn(async () => {
      throw new Error("DB lock error");
    });
    await expect(runWorktreeRecipes(SESSION, [WT], deps)).resolves.toBeUndefined();
    expect(listRecipeRuns()).toEqual([]);
  });
});

describe("F26 WorktreeRecipePanel", () => {
  const renderPanel = () =>
    render(
      <I18nProvider>
        <WorktreeRecipePanel />
      </I18nProvider>,
    );

  it("renders nothing while no recipe ran", () => {
    renderPanel();
    expect(document.querySelector(".worktree-recipe-panel")).toBeNull();
  });

  it("asks with the commands, then streams the log, then can be closed", async () => {
    let finish: (o: RecipeOutcome) => void = () => {};
    const { deps } = fakeDeps(file(RECIPE));
    deps.run = vi.fn(
      (req: RecipeRunRequest) =>
        new Promise<RecipeOutcome>((resolve) => {
          appendRecipeLine(req.runId, { stream: "command", text: "$ node scripts/setup.js" });
          finish = resolve;
        }),
    );
    renderPanel();
    const done = runWorktreeRecipes(SESSION, [WT], deps);
    await screen.findByText("Run setup");
    expect(screen.getByText("node scripts/setup.js")).toBeTruthy();
    expect(screen.getByText("Copy files git ignores: .env*")).toBeTruthy();
    expect(screen.getByText("Waiting for you")).toBeTruthy();

    // While it asks, the panel is above the wizard that waits on it.
    expect(document.querySelector(".worktree-recipe-panel-active")).not.toBeNull();
    fireEvent.click(screen.getByText("Run setup"));
    await screen.findByText("Running");
    expect(screen.getByRole("log").textContent).toContain("$ node scripts/setup.js");
    act(() => appendRecipeLine(listRecipeRuns()[0].runId, { stream: "stderr", text: "warn: something" }));
    expect(screen.getByRole("log").textContent).toContain("warn: something");
    expect(screen.getByText("Stop")).toBeTruthy();
    expect(screen.queryByText("Close")).toBeNull();

    await act(async () => {
      finish({ ok: true, stopped: false, failure: null, copied: [], ports: { web: 3001 } });
      await done;
    });
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Ports: web 3001")).toBeTruthy();
    expect(screen.getByText("Done when: npm test")).toBeTruthy();
    // A good run folds its log away and drops below dialogs.
    expect(screen.queryByRole("log")).toBeNull();
    expect(document.querySelector(".worktree-recipe-panel-active")).toBeNull();
    fireEvent.click(screen.getByText("Show log"));
    expect(screen.getByRole("log").textContent).toContain("warn: something");
    fireEvent.click(screen.getByText("Close"));
    expect(document.querySelector(".worktree-recipe-panel")).toBeNull();
  });

  it("shows why a run failed", async () => {
    const failed: RecipeOutcome = { ok: false, stopped: false, failure: "`npm ci` exited with code 1", copied: [], ports: {} };
    const { deps } = fakeDeps(file(RECIPE, true), failed);
    renderPanel();
    await act(async () => {
      await runWorktreeRecipes(SESSION, [WT], deps);
    });
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("`npm ci` exited with code 1")).toBeTruthy();
    expect(screen.getByRole("log").textContent).toContain("installing");
  });
});

/**
 * "Start a task" with library picks (src/launcher/launchTask.ts): the
 * rendered prompt is the task every agent starts with; a persona reaches
 * Claude as its system prompt (--append-system-prompt) and every other
 * agent as the start of its first prompt; an agent that takes no first
 * prompt gets both on the clipboard; a persona alone is a launch too.
 */
import { describe, expect, it, vi } from "vitest";
import { launchTask, queuedLaunchOpts, type LaunchTaskDeps } from "../launcher/launchTask";
import type { CreateSessionOpts, SessionData } from "../types/session";
import type { PlannedAgent, TaskLaunchRequest } from "../components/TaskLauncher";
import type { LaunchChoice } from "../agent/capabilities/types";

const CHOICE: LaunchChoice = {
  agentId: "claude",
  accountId: "default",
  approvalModeId: "acceptEdits",
  modelId: "default",
  effort: null,
  extraArgs: "",
  prefix: "",
  channels: [],
  where: { kind: "new-worktree", baseBranch: "", branch: "" },
  trackAsFeature: false,
};

function agent(id: string, mode: "terminal" | "agent" = "terminal"): PlannedAgent {
  return {
    id,
    mode,
    branch: `hermes/${id}`,
    createBranch: true,
    baseBranch: "",
    worktree: true,
    launch: { permissionMode: "acceptEdits", customPrefix: "", customSuffix: "", channels: [] },
    choice: { ...CHOICE, agentId: id },
  };
}

function fake() {
  const created: CreateSessionOpts[] = [];
  const copied: string[] = [];
  let n = 0;
  const deps: LaunchTaskDeps = {
    projectFor: async () => "proj-1",
    createSession: vi.fn(async (opts: CreateSessionOpts) => {
      created.push(opts);
      return { id: `s${++n}` } as SessionData;
    }),
    place: () => {},
    worktreePath: async (id) => `/fixture-home/wt/${id}`,
    writeFeatureFile: async (c, s) => `${c}/${s}`,
    copyText: async (t) => {
      copied.push(t);
    },
    readRecords: async () => "",
    writeRecords: async () => {},
    now: () => 1000,
    newLaunchId: () => "launch-1",
  };
  return { deps, created, copied };
}

const PERSONA = { id: "security-auditor", version: "1.0.0", title: "Security auditor", text: "From now on, work as this persona: Security auditor.\n\nReport exploitable issues only." };
const PROMPT = { id: "review-pull-request", version: "1.2.0", title: "Review a pull request" };

const req = (agents: PlannedAgent[], over: Partial<TaskLaunchRequest> = {}): TaskLaunchRequest => ({
  task: "Review feat/checkout for correctness.",
  repoRoot: "/fixture-home/repo",
  agents,
  track: "Quick",
  doneWhen: [],
  choice: CHOICE,
  library: { prompt: PROMPT, persona: PERSONA },
  ...over,
});

describe("launching with library picks", () => {
  it("gives Claude the persona as its system prompt and Codex as its first prompt", async () => {
    const { deps, created } = fake();
    const r = await launchTask(req([agent("claude"), agent("codex")]), deps);
    expect(r.ok).toBe(true);
    expect(created[0].systemPrompt).toBe(PERSONA.text);
    expect(created[0].initialPrompt).toBe("Review feat/checkout for correctness.");
    expect(created[1].systemPrompt).toBeUndefined();
    expect(created[1].initialPrompt).toBe(`${PERSONA.text}\n\nReview feat/checkout for correctness.`);
  });

  it("puts persona and task on the clipboard for an agent that takes no first prompt", async () => {
    const { deps, copied, created } = fake();
    const r = await launchTask(req([agent("goose")]), deps);
    expect(r.copiedFor).toEqual(["goose"]);
    expect(copied).toEqual([`${PERSONA.text}\n\nReview feat/checkout for correctness.`]);
    expect(created[0].systemPrompt).toBeUndefined();
  });

  it("launches a persona alone (no task yet)", async () => {
    const { deps, created } = fake();
    const r = await launchTask(req([agent("claude"), agent("gemini")], { task: "", library: { persona: PERSONA } }), deps);
    expect(r.ok).toBe(true);
    expect(created[0].label).toBe("Security auditor");
    expect(created[0].systemPrompt).toBe(PERSONA.text);
    expect(created[0].initialPrompt).toBe("");
    expect(created[1].initialPrompt).toContain('Reply "ready" and wait for my task.');
  });

  it("names the session after the library prompt, not the markup its text opens with", async () => {
    const { deps, created } = fake();
    await launchTask(req([agent("claude")], { task: "<context>\nYou are reviewing a change before it merges.", library: { prompt: PROMPT } }), deps);
    expect(created[0].label).toBe("Review a pull request");
    expect(created[0].initialPrompt).toBe("<context>\nYou are reviewing a change before it merges.");
  });

  it("changes nothing without library picks", async () => {
    const { deps, created } = fake();
    await launchTask(req([agent("claude")], { library: undefined }), deps);
    expect(created[0].systemPrompt).toBeUndefined();
    expect(created[0].initialPrompt).toBe("Review feat/checkout for correctness.");
    expect(created[0].label).toBe("Review feat/checkout for correctness.");
  });

  it("a queued launch starts with the same prompts", () => {
    const opts = queuedLaunchOpts({ req: req([agent("claude")]), agentIndex: 0, projectId: "p", launchId: "l", firstPrompt: "Review it" });
    expect(opts.systemPrompt).toBe(PERSONA.text);
    expect(opts.initialPrompt).toBe("Review it");
  });
});

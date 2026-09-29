// @vitest-environment jsdom
/**
 * F22 — the Land sheet with the Tauri bridge mocked: what it shows, what it
 * asks the backend to do, and what it pastes into the session (never an
 * Enter). The git side is in src-tauri/src/land/; the real app journey is
 * e2e/app/scenarios/F22-land-sheet.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  getVersion: vi.fn(() => Promise.resolve("1.4.0")),
  closeSession: vi.fn(async () => {}),
  createSession: vi.fn(async () => "restored"),
  shellOpen: vi.fn(async () => {}),
  sessions: {} as Record<string, { label: string }>,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: h.getVersion }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: h.shellOpen }));
vi.mock("../state/SessionContext", () => ({
  useSession: () => ({
    state: { sessions: h.sessions },
    closeSession: h.closeSession,
    createSession: h.createSession,
  }),
}));

import { LandSheet } from "../land/LandSheet";
import { I18nProvider } from "../i18n/I18nProvider";
import { LandSheetHost, openLandSheet } from "../land/LandSheetHost";
import { dispatchSessionEvent, _resetSessionEventStoreForTest } from "../agent/contract/sessionEventStore";
import { setFakeLandTurnsForTest } from "../land/turnSource";
import { initFeatureFlags, __resetFeatureFlagsForTest, FEATURE_FLAG_OVERRIDES_KEY } from "../featureFlags";
import type { LandPreview, LandRecord, GhStatus } from "../land/api";

const SID = "sess-1";
const PID = "proj-1";

function preview(over: Partial<LandPreview> = {}): LandPreview {
  return {
    branch: "hermes/add-search",
    head: "1111111111",
    uncommittedFiles: 2,
    commitsAhead: 1,
    diffstat: { files: 3, insertions: 12, deletions: 4 },
    changedFiles: ["src/a.ts", "src/b.ts", "README.md"],
    base: { name: "main", head: "2222222222", checkedOutAt: "/repo" },
    merge: { kind: "fast_forward" },
    worktreePath: "/data/hermes-worktrees/h/s_add-search",
    repoPath: "/repo",
    shared: false,
    remote: "origin",
    worktreeToml: 'done_when = ["npm test"]\n',
    features: [],
    landings: [],
    ...over,
  };
}

function record(over: Partial<LandRecord> = {}): LandRecord {
  return {
    id: `${SID}-1`,
    n: 1,
    sessionId: SID,
    projectId: PID,
    repoPath: "/repo",
    worktreePath: "/data/hermes-worktrees/h/s_add-search",
    branch: "hermes/add-search",
    label: "Search",
    mode: "merge",
    createdAt: 1,
    branchBefore: "1111111111",
    branchAfter: "3333333333",
    base: "main",
    baseBefore: "2222222222",
    mergedCommit: "4444444444",
    remote: null,
    remoteBefore: null,
    pushed: null,
    prUrl: null,
    archived: false,
    undoneSteps: [],
    undone: false,
    ...over,
  };
}

interface Backend {
  preview: LandPreview;
  gh: GhStatus;
  calls: Array<{ cmd: string; args: Record<string, unknown> }>;
  execute?: (args: Record<string, unknown>) => unknown;
}

function backend(over: Partial<Backend> = {}): Backend {
  const b: Backend = {
    preview: preview(),
    gh: { state: "ready", detail: "Logged in" },
    calls: [],
    ...over,
  };
  h.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown> = {}) => {
    b.calls.push({ cmd, args });
    switch (cmd) {
      case "land_preview":
        return b.preview;
      case "land_gh_status":
        return b.gh;
      case "git_worktree_usage":
        return { path: b.preview.worktreePath, total_bytes: 5_000_000, build_output_bytes: 4_000_000 };
      case "list_turns":
        return [];
      case "land_execute":
        return b.execute
          ? b.execute(args)
          : { status: "landed", record: record({ mode: (args.request as { mode: LandRecord["mode"] }).mode }), conflictFiles: [], error: null };
      case "land_archive":
        return { record: record({ archived: true }), totalBytes: 5_000_000, buildOutputBytes: 4_000_000 };
      case "land_undo":
        return {
          record: record({ undone: true }),
          steps: ["main is back at 22222222", "Restored the worktree of hermes/add-search"],
          restored: { sessionId: (args as { restoreSessionId: string }).restoreSessionId, projectId: PID, worktreePath: "/w", branch: "hermes/add-search", label: "Search" },
        };
      case "land_pr_checks":
        return [
          { name: "lint", state: "SUCCESS", bucket: "pass", link: "", workflow: "CI" },
          { name: "test", state: "FAILURE", bucket: "fail", link: "https://github.test/o/r/actions/runs/9/job/10", workflow: "CI" },
        ];
      case "land_ci_log":
        return { relativePath: ".hermes/ci/test.log", bytes: 12 };
      case "write_to_session":
        return null;
      default:
        throw new Error(`unexpected ${cmd}`);
    }
  });
  return b;
}

function calls(b: Backend, cmd: string) {
  return b.calls.filter((c) => c.cmd === cmd);
}

async function openSheet() {
  const onClose = vi.fn();
  render(<I18nProvider><LandSheet sessionId={SID} projectId={PID} onClose={onClose} /></I18nProvider>);
  await screen.findByText("Squash-merge into main locally");
  return onClose;
}

function option(mode: string) {
  return document.querySelector(`.land-sheet-option[data-mode="${mode}"]`) as HTMLElement;
}

beforeEach(() => {
  h.invoke.mockReset();
  h.closeSession.mockClear();
  h.createSession.mockClear();
  h.shellOpen.mockClear();
  h.sessions = { [SID]: { label: "Search" } };
  _resetSessionEventStoreForTest();
  // The stand-in turns are read only in test builds.
  vi.stubEnv("VITE_HERMES_E2E", "1");
  setFakeLandTurnsForTest(SID, []);
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("what the sheet shows", () => {
  it("shows Done-When, the turn count, the diffstat and the disk used", async () => {
    backend();
    setFakeLandTurnsForTest(SID, [
      {
        turn: { sessionId: SID, n: 1, ref: "r", startedAt: 1, endedAt: 2, diffstat: { files: 2, insertions: 9, deletions: 1 } },
        patch: "diff --git a/src/a.ts b/src/a.ts\n",
      },
      {
        turn: { sessionId: SID, n: 2, ref: "r", startedAt: 3, endedAt: 4, diffstat: { files: 1, insertions: 3, deletions: 3 } },
        patch: "diff --git a/README.md b/README.md\n",
      },
    ]);
    await openSheet();
    await waitFor(() => expect(document.querySelector(".land-sheet-turns")?.getAttribute("data-turns")).toBe("2"));
    expect(document.querySelector(".land-sheet-donewhen")?.textContent).toContain("1 check, no result yet");
    expect(document.querySelector(".land-sheet-diffstat")?.textContent).toContain("3 files +12 -4");
    await waitFor(() => expect(document.querySelector(".land-sheet-disk")?.textContent).toContain("5.0 MB (build output 4.0 MB)"));
    const message = (document.querySelector(".land-sheet-message") as HTMLTextAreaElement).value;
    expect(message).toBe("Add search\n\n2 turns:\n- Turn 1: 2 files, +9 -1 (src/a.ts)\n- Turn 2: 1 file, +3 -3 (README.md)");
  });

  it("says nothing about the branch when landing goes to main", async () => {
    backend();
    await openSheet();
    expect(document.querySelector(".land-sheet-base-note")).toBeNull();
  });

  it("warns when the project folder is on another branch than main", async () => {
    backend({ preview: preview({ base: { name: "release-1", head: "2222222222", checkedOutAt: "/repo" } }) });
    render(<I18nProvider><LandSheet sessionId={SID} projectId={PID} onClose={vi.fn()} /></I18nProvider>);
    await screen.findByText("Squash-merge into release-1 locally");
    expect(document.querySelector(".land-sheet-base-note")?.textContent).toBe(
      "The project folder has release-1 checked out, so this lands on release-1. To land on your main branch, check it out in the project folder first.",
    );
  });

  it("counts turns the session reported even before the ledger has them", async () => {
    backend();
    dispatchSessionEvent(SID, { type: "turn_start", at: 1, n: 1 });
    dispatchSessionEvent(SID, { type: "turn_end", at: 2, n: 1 });
    await openSheet();
    expect(document.querySelector(".land-sheet-turns")?.getAttribute("data-turns")).toBe("1");
  });

  it("disables the pull request with a sign-in link when gh is signed out", async () => {
    backend({ gh: { state: "signed_out", detail: "not logged in" } });
    await openSheet();
    await waitFor(() => expect(option("pr").getAttribute("aria-disabled")).toBe("true"));
    expect(option("pr").textContent).toContain("GitHub CLI (gh) is not signed in.");
    fireEvent.click(screen.getByText("Sign in: run gh auth login"));
    expect(h.shellOpen).toHaveBeenCalledWith("https://cli.github.com/manual/gh_auth_login");
  });

  it("keeps the person's pick when the GitHub CLI status arrives after it (it is never replaced by the default)", async () => {
    const b = backend();
    let answerGh!: (g: GhStatus) => void;
    const late = new Promise<GhStatus>((resolve) => {
      answerGh = resolve;
    });
    const base = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown> = {}) => (cmd === "land_gh_status" ? late : base(cmd, args)));
    await openSheet();
    const merge = option("merge").querySelector("input") as HTMLInputElement;
    await waitFor(() => expect(merge.disabled).toBe(false));
    // Nothing is picked while the pull request option is still being checked.
    expect(document.querySelector<HTMLInputElement>('input[name="land-mode"]:checked')).toBeNull();
    fireEvent.click(merge);
    expect(merge.checked).toBe(true);
    // The status arrives: a pull request could now be opened, which is the
    // option the sheet picks by itself; the person already chose.
    await act(async () => {
      answerGh(b.gh);
      await late;
    });
    await waitFor(() => expect(option("pr").getAttribute("aria-disabled")).toBe("false"));
    expect(merge.checked).toBe(true);
    expect((option("pr").querySelector("input") as HTMLInputElement).checked).toBe(false);
  });

  it("picks a pull request by itself once the status says it can, when nothing was picked", async () => {
    backend();
    await openSheet();
    await waitFor(() => expect((option("pr").querySelector("input") as HTMLInputElement).checked).toBe(true));
  });

  it("offers to install gh when it is missing", async () => {
    backend({ gh: { state: "missing", detail: "" } });
    await openSheet();
    await waitFor(() => expect(option("pr").getAttribute("aria-disabled")).toBe("true"));
    fireEvent.click(screen.getByText("Install GitHub CLI"));
    expect(h.shellOpen).toHaveBeenCalledWith("https://cli.github.com");
  });

  it("makes Land anyway secondary while Done-When fails", async () => {
    backend();
    dispatchSessionEvent(SID, {
      type: "status",
      at: 1,
      status: { kind: "check_failed", confidence: "exact", detail: "npm test exited 1" },
    });
    await openSheet();
    const land = document.querySelector(".land-sheet-land") as HTMLButtonElement;
    expect(land.textContent).toBe("Land anyway");
    expect(land.className).toContain("land-sheet-btn-secondary");
    expect(document.querySelector(".land-sheet-cancel")?.className).toContain("land-sheet-btn-primary");
    expect(document.querySelector(".land-sheet-donewhen")?.textContent).toContain("Failing: npm test exited 1");
  });
});

describe("landing", () => {
  it("squash-merges with the drafted message, archives, and undo restores it in a new session", async () => {
    const b = backend();
    await openSheet();
    fireEvent.click(option("merge").querySelector("input")!);
    fireEvent.click(document.querySelector(".land-sheet-archive-after")!);
    fireEvent.click(document.querySelector(".land-sheet-land")!);
    await screen.findByText(/Squash-merged into main/);
    const exec = calls(b, "land_execute")[0].args;
    expect(exec).toMatchObject({ sessionId: SID, projectId: PID, request: { mode: "merge", label: "Search" } });
    expect((exec.request as { message: string }).message).toMatch(/^Add search\n/);
    // Archive: recorded against the landing, then the session closes.
    expect(calls(b, "land_archive")[0].args).toMatchObject({ landId: `${SID}-1` });
    expect(h.closeSession).toHaveBeenCalledWith(SID);
    expect(document.querySelector(".land-sheet-archived")?.textContent).toContain("including 4.0 MB of build output");

    fireEvent.click(document.querySelector(".land-sheet-undo")!);
    await screen.findByText("Undone.");
    const restoreId = (calls(b, "land_undo")[0].args as { restoreSessionId: string }).restoreSessionId;
    expect(h.createSession).toHaveBeenCalledWith({ sessionId: restoreId, projectIds: [PID], label: "Search" });
    expect(screen.getByText("main is back at 22222222")).toBeTruthy();
  });

  it("routes a predicted conflict to a pull request or a rebase request, never a merge", async () => {
    const b = backend({ preview: preview({ merge: { kind: "conflict", files: ["src/a.ts"] } }) });
    await openSheet();
    expect(option("merge").getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector(".land-sheet-conflict")?.textContent).toContain("conflict in src/a.ts");
    fireEvent.click(screen.getByText("Ask agent to rebase"));
    await waitFor(() => expect(calls(b, "write_to_session")).toHaveLength(1));
    const data = Buffer.from(calls(b, "write_to_session")[0].args.data as string, "base64").toString("utf8");
    expect(data).toBe("Please rebase this branch onto main and resolve the conflicts in src/a.ts.");
    expect(data).not.toMatch(/[\r\n]/);
    fireEvent.click(screen.getByText("Open a pull request instead"));
    expect((option("pr").querySelector("input") as HTMLInputElement).checked).toBe(true);
    expect(calls(b, "land_execute")).toHaveLength(0);
  });

  it("shows a conflict found while landing with the same routes", async () => {
    backend({
      execute: () => ({ status: "conflict", record: null, conflictFiles: ["x.txt"], error: null }),
    });
    await openSheet();
    fireEvent.click(option("merge").querySelector("input")!);
    fireEvent.click(document.querySelector(".land-sheet-land")!);
    await waitFor(() => expect(document.querySelector(".land-sheet-conflict")?.textContent).toContain("x.txt"));
    expect(screen.getByText("Ask agent to rebase")).toBeTruthy();
  });

  it("opens a PR with the drafted body, shows its checks and pastes the failing log request", async () => {
    const b = backend({
      execute: () => ({
        status: "landed",
        record: record({ mode: "pr", mergedCommit: null, prUrl: "https://github.test/o/r/pull/7", pushed: "3333333333", remote: "origin" }),
        conflictFiles: [],
        error: null,
      }),
    });
    await openSheet();
    await waitFor(() => expect((option("pr").querySelector("input") as HTMLInputElement).checked).toBe(true));
    expect(document.querySelector(".land-sheet-prbody-text")?.textContent).toContain("## Turns");
    fireEvent.click(document.querySelector(".land-sheet-land")!);
    await screen.findByText("Send failing CI log to the agent");
    const req = calls(b, "land_execute")[0].args.request as { mode: string; prBody: string };
    expect(req.mode).toBe("pr");
    expect(req.prBody).toContain("## Done-When\n\n- `npm test`");
    fireEvent.click(screen.getByText("Send failing CI log to the agent"));
    await waitFor(() => expect(calls(b, "write_to_session")).toHaveLength(1));
    expect(calls(b, "land_ci_log")[0].args).toMatchObject({ landId: `${SID}-1`, checkName: "test" });
    const data = Buffer.from(calls(b, "write_to_session")[0].args.data as string, "base64").toString("utf8");
    expect(data).toContain(".hermes/ci/test.log");
    expect(data).not.toMatch(/[\r\n]/);
  });

  it("archives on its own only when nothing is uncommitted", async () => {
    const b = backend();
    await openSheet();
    expect((document.querySelector(".land-sheet-archive") as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    b.preview = preview({ uncommittedFiles: 0 });
    await openSheet();
    fireEvent.click(document.querySelector(".land-sheet-archive")!);
    await waitFor(() => expect(h.closeSession).toHaveBeenCalledWith(SID));
    expect(calls(b, "land_archive")[0].args).toMatchObject({ landId: null });
  });
});

describe("the host", () => {
  it("opens only with the landSheet flag on", async () => {
    backend();
    __resetFeatureFlagsForTest();
    await initFeatureFlags({ [FEATURE_FLAG_OVERRIDES_KEY]: JSON.stringify({ landSheet: false }) });
    const { unmount } = render(<I18nProvider><LandSheetHost /></I18nProvider>);
    openLandSheet(SID, PID);
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector(".land-sheet")).toBeNull();
    unmount();

    __resetFeatureFlagsForTest();
    await initFeatureFlags({ [FEATURE_FLAG_OVERRIDES_KEY]: JSON.stringify({ landSheet: true }) });
    render(<I18nProvider><LandSheetHost /></I18nProvider>);
    openLandSheet(SID, PID);
    await screen.findByText("Squash-merge into main locally");
  });
});

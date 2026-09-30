// @vitest-environment jsdom
/**
 * F21 Review Desk: the surface, driven like a person would, over a faked
 * backend (invoke) and injected turns. Covers grouping by file and by
 * turn, risk flags, viewed marks, comment routing to the agent that made
 * the turn, send-back with the delivery receipt, and the revert preview.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("../state/SessionContext", () => ({
  useSession: () => ({ state: {}, dispatch: h.dispatch }),
}));
vi.mock("../i18n/I18nProvider", async () => {
  const { translate } = await import("../i18n/registry");
  return { useI18n: () => ({ t: translate }) };
});
vi.mock("../components/GitLogView", () => ({ GitLogView: () => <div data-testid="git-log-stub" /> }));
vi.mock("../components/GitStashSection", () => ({ GitStashSection: () => <div data-testid="git-stash-stub" /> }));
vi.mock("../components/GitMergeBanner", () => ({ GitMergeBanner: () => null }));
vi.mock("../components/GitConflictViewer", () => ({ GitConflictViewer: () => null }));

import { ReviewDesk, turnForPath, normalizePath, type TurnEntry } from "../components/ReviewDesk";
import { clearFakeTurns, injectFakeTurns } from "../review/turnSource";
import { _resetReviewStoreForTest } from "../review/reviewStore";
import { dispatchSessionEvent, _resetSessionEventStoreForTest } from "../agent/contract/sessionEventStore";
import { parsePatch } from "../review/patch";
import type { SessionData } from "../types/session";

const PATCH_A = "diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n export default a + b;\n";
const PATCH_B = "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1,2 +1,3 @@\n {\n+  \"x\": 1,\n }\n";

// Started through the helper (launchHelper on), so its prompt hook is installed and a receipt can come back.
const STARTED = { state: "started", since: "2026-01-01T00:00:00Z", confidence: "exact" } as const;
const session = (id: string, label: string, extra: Partial<SessionData> = {}): SessionData =>
  ({ id, label, working_directory: "/fixture/repo", mode: "terminal", phase: "running", ai_provider: "claude", agent_startup: STARTED, ...extra }) as SessionData;
const working = (at: number) => ({ type: "status", at, status: { kind: "working", confidence: "exact", detail: "" } }) as const;
const turnEnded = (at: number) => ({ type: "status", at, status: { kind: "done_unread", confidence: "exact", detail: "" } }) as const;
const pastes = () => h.invoke.mock.calls.filter((c) => c[0] === "write_to_session");
async function commentForA(text: string) {
  fireEvent.click(screen.getByRole("radio", { name: "By turn" }));
  fireEvent.click(document.querySelector('.review-turn-row[data-turn="1"]')!);
  await waitFor(() => expect(document.querySelector('.review-line.review-line-add[data-path="src/app.js"]')).toBeInTheDocument());
  fireEvent.click(document.querySelector('.review-line.review-line-add[data-path="src/app.js"]')!);
  fireEvent.change(await screen.findByPlaceholderText(/Comment for Agent A/), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
}
const SESSIONS = [session("sess-a", "Agent A"), session("sess-b", "Agent B"), session("sess-c", "Elsewhere", { working_directory: "/fixture/other" })];

function fileOf(patch: string, path: string) {
  const p = parsePatch(patch)[0];
  return { path, status: p.status, isBinary: false, executable: false, additions: p.additions, deletions: p.deletions, patch, truncated: false };
}
const DIFF = { base: "abc", baseRef: "main", head: "def", branch: "hermes/task", files: [fileOf(PATCH_A, "src/app.js"), fileOf(PATCH_B, "package-lock.json")] };

function backend(overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  h.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd in overrides) return overrides[cmd](args);
    switch (cmd) {
      case "review_diff":
        return DIFF;
      case "review_write_file":
        return `/data/reviews/${String(args.sessionId)}/review-${String(args.n)}.md`;
      case "write_to_session":
        return undefined;
      case "review_revert_preview":
        return { clean: true, message: "", files: parsePatch(String(args.patch)).map((f) => ({ ...f, patch: f.raw, truncated: false })) };
      case "review_revert_patch":
        return { ok: true, method: "plain", message: "" };
      case "git_status":
        return { projects: [], timestamp: 0 };
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
}

const turn = (sessionId: string, n: number, startedAt: number) => ({ sessionId, n, ref: `refs/hermes/${sessionId}/turn/${n}`, startedAt, endedAt: startedAt + 1, diffstat: { files: 1, insertions: 1, deletions: 1 } });

beforeEach(() => {
  h.invoke.mockReset();
  h.dispatch.mockReset();
  _resetReviewStoreForTest();
  _resetSessionEventStoreForTest();
  clearFakeTurns();
  localStorage.clear();
  injectFakeTurns("sess-a", [{ turn: turn("sess-a", 1, 100), patch: PATCH_A }]);
  injectFakeTurns("sess-b", [{ turn: turn("sess-b", 2, 200), patch: PATCH_B }]);
  backend();
});
afterEach(cleanup);

const rows = () => [...document.querySelectorAll<HTMLElement>(".review-file-row")].map((r) => r.dataset.path);
const flagsOf = (path: string) => document.querySelector<HTMLElement>(`.review-file-row[data-path="${path}"]`)?.dataset.flags ?? "";

async function open(sessionId = "sess-a") {
  const onClose = vi.fn();
  render(<ReviewDesk sessionId={sessionId} sessions={SESSIONS} onClose={onClose} />);
  await waitFor(() => expect(document.querySelector(".review-desk")?.getAttribute("data-loading")).toBe("0"));
  return onClose;
}

describe("ReviewDesk", () => {
  it("shows the merge-base diff by file with risk flags, and only the repository's own sessions' turns", async () => {
    await open();
    expect(h.invoke).toHaveBeenCalledWith("review_diff", { path: "/fixture/repo" });
    expect(rows()).toEqual(["src/app.js", "package-lock.json"]);
    expect(flagsOf("package-lock.json")).toBe("lockfile");
    expect(flagsOf("src/app.js")).toBe("");
    expect(screen.getByText(/hermes\/task → main/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "By turn" }));
    const turns = [...document.querySelectorAll<HTMLElement>(".review-turn-row")].map((r) => `${r.dataset.session}:${r.dataset.turn}:${r.querySelector(".review-turn-agent")?.textContent}`);
    expect(turns).toEqual(["sess-a:1:Agent A", "sess-b:2:Agent B"]);
    // The session in another folder contributed nothing.
    expect(h.invoke).not.toHaveBeenCalledWith("list_turns", { sessionId: "sess-c" });
  });

  it("does not reload, and keeps an open comment, when only a session's state changes", async () => {
    const onClose = vi.fn();
    const { rerender } = render(<ReviewDesk sessionId="sess-a" sessions={SESSIONS} onClose={onClose} />);
    await waitFor(() => expect(document.querySelector(".review-desk")?.getAttribute("data-loading")).toBe("0"));
    fireEvent.click(screen.getByRole("radio", { name: "By turn" }));
    fireEvent.click(document.querySelector('.review-turn-row[data-turn="1"]')!);
    await waitFor(() => expect(document.querySelector('.review-line.review-line-add[data-path="src/app.js"]')).toBeInTheDocument());
    fireEvent.click(document.querySelector('.review-line.review-line-add[data-path="src/app.js"]')!);
    await screen.findByPlaceholderText(/Comment for Agent A/);
    const diffs = () => h.invoke.mock.calls.filter((c) => c[0] === "review_diff").length;
    const before = diffs();
    // The same sessions in new objects, as every status update delivers them.
    rerender(<ReviewDesk sessionId="sess-a" sessions={SESSIONS.map((s) => ({ ...s, phase: "busy" }))} onClose={onClose} />);
    await act(async () => {});
    expect(diffs()).toBe(before);
    expect(document.querySelector(".review-desk")?.getAttribute("data-loading")).toBe("0");
    expect(screen.getByPlaceholderText(/Comment for Agent A/)).toBeInTheDocument();
  });

  it("keeps a viewed mark across reopening and lets Escape close", async () => {
    const onClose = await open();
    const box = document.querySelector<HTMLInputElement>('.review-file-row[data-path="src/app.js"] .review-viewed input')!;
    fireEvent.click(box);
    await waitFor(() => expect(document.querySelector(".review-summary")?.getAttribute("data-viewed")).toBe("1"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    cleanup();
    await open();
    expect(document.querySelector<HTMLInputElement>('.review-file-row[data-path="src/app.js"] .review-viewed input')?.checked).toBe(true);
  });

  it("routes a comment to the agent whose turn changed the line, sends one tagged line, and reports the receipt", async () => {
    await open();
    fireEvent.click(screen.getByRole("radio", { name: "By turn" }));
    fireEvent.click(document.querySelector('.review-turn-row[data-turn="2"]')!);
    await waitFor(() => expect(document.querySelector('.review-line.review-line-add[data-path="package-lock.json"]')).toBeInTheDocument());
    fireEvent.click(document.querySelector('.review-line.review-line-add[data-path="package-lock.json"]')!);
    const ta = await screen.findByPlaceholderText(/Comment for Agent B/);
    fireEvent.change(ta, { target: { value: "Why does the lockfile change?" } });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    const comment = await waitFor(() => document.querySelector<HTMLElement>(".review-comment")!);
    expect(comment.dataset.session).toBe("sess-b");
    expect(comment.dataset.turn).toBe("2");
    expect(comment.textContent).toContain("to Agent B");

    // Nothing is pasted until the person presses Send.
    expect(h.invoke).not.toHaveBeenCalledWith("write_to_session", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Send to Agent B" }));
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("review_write_file", expect.objectContaining({ sessionId: "sess-b", n: 1 })));
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("write_to_session", expect.objectContaining({ sessionId: "sess-b" })));
    const written = h.invoke.mock.calls.find((c) => c[0] === "review_write_file")![1] as { content: string };
    expect(written.content).toContain("# Review 1 for Agent B");
    expect(written.content).toContain("Why does the lockfile change?");
    const pasted = atob((h.invoke.mock.calls.find((c) => c[0] === "write_to_session")![1] as { data: string }).data);
    expect(pasted.startsWith("\x1b[200~[hermes-review #1] ")).toBe(true);
    expect(pasted.endsWith("\x1b[201~\r")).toBe(true);
    expect(pasted).toContain("/data/reviews/sess-b/review-1.md");
    expect(pasted.split("\r").length).toBe(2); // one line, one Enter
    expect(document.querySelector(".review-delivery")?.getAttribute("data-state")).toBe("sending");

    // A foreign tag, or the tag on another session, does not count.
    act(() => {
      dispatchSessionEvent("sess-b", { type: "status", at: 1, tags: ["hermes-review#9"], status: { kind: "working", confidence: "exact", detail: "" } });
      dispatchSessionEvent("sess-a", { type: "status", at: 1, tags: ["hermes-review#1"], status: { kind: "working", confidence: "exact", detail: "" } });
    });
    expect(document.querySelector(".review-delivery")?.getAttribute("data-state")).toBe("sending");
    act(() => {
      dispatchSessionEvent("sess-b", { type: "status", at: 2, tags: ["hermes-review#1"], status: { kind: "working", confidence: "exact", detail: "" } });
    });
    await waitFor(() => expect(document.querySelector(".review-delivery")?.getAttribute("data-state")).toBe("delivered"));
    expect(comment.dataset.sent).toBe("1");
  });

  it("shows not delivered with Retry when the agent never reports the line, and Retry pastes it again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await open();
      fireEvent.click(screen.getByRole("radio", { name: "By turn" }));
      fireEvent.click(document.querySelector('.review-turn-row[data-turn="1"]')!);
      await waitFor(() => expect(document.querySelector('.review-line.review-line-add[data-path="src/app.js"]')).toBeInTheDocument());
      fireEvent.click(document.querySelector('.review-line.review-line-add[data-path="src/app.js"]')!);
      fireEvent.change(await screen.findByPlaceholderText(/Comment for Agent A/), { target: { value: "Why 3?" } });
      fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
      fireEvent.click(await screen.findByRole("button", { name: "Send to Agent A" }));
      await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("write_to_session", expect.objectContaining({ sessionId: "sess-a" })));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      await waitFor(() => expect(document.querySelector(".review-delivery")?.getAttribute("data-state")).toBe("not_delivered"));
      const pastes = () => h.invoke.mock.calls.filter((c) => c[0] === "write_to_session").length;
      expect(pastes()).toBe(1);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(pastes()).toBe(2));
      const [first, second] = h.invoke.mock.calls.filter((c) => c[0] === "write_to_session").map((c) => (c[1] as { data: string }).data);
      expect(second).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("types nothing into a working agent: Send stops at waiting, and only Send now — enabled once the turn ended — pastes", async () => {
    await open();
    act(() => {
      dispatchSessionEvent("sess-a", working(1));
      // It works quietly: the terminal guesses it is idle (launchHelper on).
      // The agent's own report stands.
      dispatchSessionEvent("sess-a", { type: "status", at: 1, source: "pty", status: { kind: "idle", confidence: "guessed", detail: "" } });
    });
    await commentForA("Why 3?");
    fireEvent.click(await screen.findByRole("button", { name: "Send to Agent A" }));
    await waitFor(() => expect(document.querySelector(".review-delivery")?.getAttribute("data-state")).toBe("waiting"));
    expect(h.invoke).toHaveBeenCalledWith("review_write_file", expect.objectContaining({ sessionId: "sess-a", n: 1 }));
    expect(pastes()).toHaveLength(0);
    const sendNow = screen.getByRole("button", { name: "Send now" }) as HTMLButtonElement;
    expect(sendNow.disabled).toBe(true);
    // Still working (a tool call): the button stays off.
    act(() => {
      dispatchSessionEvent("sess-a", working(2));
    });
    expect((screen.getByRole("button", { name: "Send now" }) as HTMLButtonElement).disabled).toBe(true);
    // The turn ends: nothing is pasted by itself; the button comes on.
    act(() => {
      dispatchSessionEvent("sess-a", turnEnded(3));
    });
    await waitFor(() => expect((screen.getByRole("button", { name: "Send now" }) as HTMLButtonElement).disabled).toBe(false));
    await new Promise((r) => setTimeout(r, 20));
    expect(pastes()).toHaveLength(0);
    expect(document.querySelector(".review-delivery")?.getAttribute("data-state")).toBe("waiting");
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(pastes()).toHaveLength(1));
    expect(atob((pastes()[0][1] as { data: string }).data)).toContain("[hermes-review #1] ");
    await waitFor(() => expect(document.querySelector(".review-delivery")?.getAttribute("data-state")).toBe("sending"));
    act(() => {
      dispatchSessionEvent("sess-a", { type: "status", at: 4, tags: ["hermes-review#1"], status: { kind: "working", confidence: "exact", detail: "" } });
    });
    await waitFor(() => expect(document.querySelector(".review-delivery")?.getAttribute("data-state")).toBe("delivered"));
    // One review, one paste.
    expect(pastes()).toHaveLength(1);
  });

  it("shows pasted, not a red not-delivered, for an agent whose launch installed no prompt hook", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // Started without the helper: no hooks, so no receipt can ever come.
      const sessions = [session("sess-a", "Agent A", { agent_startup: null }), SESSIONS[1]];
      render(<ReviewDesk sessionId="sess-a" sessions={sessions} onClose={() => {}} />);
      await waitFor(() => expect(document.querySelector(".review-desk")?.getAttribute("data-loading")).toBe("0"));
      await commentForA("Why 3?");
      fireEvent.click(await screen.findByRole("button", { name: "Send to Agent A" }));
      await waitFor(() => expect(pastes()).toHaveLength(1));
      await waitFor(() => expect(document.querySelector(".review-delivery")?.getAttribute("data-state")).toBe("pasted"));
      expect(document.querySelector(".review-delivery")?.textContent).toContain("cannot confirm");
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      expect(screen.getByRole("button", { name: "Copy line" })).toBeInTheDocument();
      // Time passing changes nothing: there is no receipt to wait for.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(document.querySelector(".review-delivery")?.getAttribute("data-state")).toBe("pasted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("after a restart a not-delivered review keeps its Retry, and Retry pastes the same review again", async () => {
    localStorage.setItem(
      "hermes.review./fixture/repo",
      JSON.stringify({
        viewed: [],
        comments: [{ id: "c-old", sessionId: "sess-a", turnN: 1, path: "src/app.js", side: "new", line: 2, excerpt: "const b = 3;", text: "Why 3?", createdAt: 1 }],
        lastN: 1,
        sent: { "c-old": 1 },
        deliveries: { 1: { kind: "sending", sessionId: "sess-a", filePath: "/data/reviews/sess-a/review-1.md" } },
      }),
    );
    await open();
    const delivery = document.querySelector<HTMLElement>('.review-delivery[data-n="1"]');
    expect(delivery?.getAttribute("data-state")).toBe("not_delivered");
    expect(pastes()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(pastes()).toHaveLength(1));
    expect(h.invoke).toHaveBeenCalledWith("review_write_file", expect.objectContaining({ sessionId: "sess-a", n: 1, content: expect.stringContaining("Why 3?") }));
    expect(atob((pastes()[0][1] as { data: string }).data)).toContain("[hermes-review #1] ");
    // The comment is still marked as sent in review 1, not re-sent as review 2.
    expect(document.querySelector<HTMLElement>(".review-comment")?.dataset.sent).toBe("1");
    expect(h.invoke).not.toHaveBeenCalledWith("review_write_file", expect.objectContaining({ n: 2 }));
  });

  it("puts the line into the composer for a structured (Agent view) session instead of pasting", async () => {
    const sessions = [session("sess-a", "Agent A", { mode: "agent" }), SESSIONS[1]];
    render(<ReviewDesk sessionId="sess-a" sessions={sessions} onClose={() => {}} />);
    await waitFor(() => expect(document.querySelector(".review-desk")?.getAttribute("data-loading")).toBe("0"));
    fireEvent.click(screen.getByRole("radio", { name: "By turn" }));
    fireEvent.click(document.querySelector('.review-turn-row[data-turn="1"]')!);
    await waitFor(() => expect(document.querySelector('.review-line.review-line-add[data-path="src/app.js"]')).toBeInTheDocument());
    fireEvent.click(document.querySelector('.review-line.review-line-add[data-path="src/app.js"]')!);
    fireEvent.change(await screen.findByPlaceholderText(/Comment for Agent A/), { target: { value: "hm" } });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send to Agent A" }));
    await waitFor(() => expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "SET_COMPOSER_DRAFT", sessionId: "sess-a" })));
    expect(String((h.dispatch.mock.calls[0][0] as { draft: string }).draft).startsWith("[hermes-review #1] ")).toBe(true);
    expect(h.invoke).not.toHaveBeenCalledWith("write_to_session", expect.anything());
    await waitFor(() => expect(document.querySelector(".review-delivery")?.getAttribute("data-state")).toBe("queued"));
  });

  it("previews a turn's revert, applies it on confirm, and reloads", async () => {
    await open();
    fireEvent.click(screen.getByRole("radio", { name: "By turn" }));
    fireEvent.click(document.querySelector('.review-turn-row[data-turn="2"]')!);
    fireEvent.click(await screen.findByRole("button", { name: "Revert turn 2" }));
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("review_revert_preview", { path: "/fixture/repo", patch: PATCH_B }));
    await waitFor(() => expect(document.querySelector(".review-revert-clean")?.getAttribute("data-clean")).toBe("1"));
    expect([...document.querySelectorAll<HTMLElement>(".review-revert-files li")].map((li) => li.dataset.path)).toEqual(["package-lock.json"]);
    expect(h.invoke).not.toHaveBeenCalledWith("review_revert_patch", expect.anything());
    const diffCalls = () => h.invoke.mock.calls.filter((c) => c[0] === "review_diff").length;
    const before = diffCalls();
    fireEvent.click(document.querySelector(".review-revert-confirm")!);
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("review_revert_patch", { path: "/fixture/repo", patch: PATCH_B }));
    await waitFor(() => expect(document.querySelector(".review-notice")?.textContent).toContain("Turn 2 reverted"));
    expect(diffCalls()).toBeGreaterThan(before);
  });

  it("pure helpers: the last turn touching a path owns comments made in the by-file view", () => {
    const a: TurnEntry = { sessionId: "sess-a", agentLabel: "A", turn: turn("sess-a", 1, 1), patch: PATCH_A, files: parsePatch(PATCH_A) };
    const b: TurnEntry = { sessionId: "sess-b", agentLabel: "B", turn: turn("sess-b", 2, 2), patch: PATCH_A, files: parsePatch(PATCH_A) };
    expect(turnForPath([a, b], "src/app.js")).toBe(b);
    expect(turnForPath([a], "nope")).toBeNull();
    expect(normalizePath("C:\\Repo\\")).toBe("c:/repo");
  });
});

describe("ReviewDesk: what the git panel it replaces offered", () => {
  const WORKTREE = { project_id: "p1", project_name: "repo", project_path: "/data/hermes-worktrees/abc/s_task", is_git_repo: true, branch: "hermes/task", files: [] };
  const FOLDER = { ...WORKTREE, project_id: "p2", project_name: "folder", project_path: "/fixture/repo" };

  it("offers Land for a project the session works on in a worktree of its own, closing the desk first", async () => {
    backend({ git_status: () => ({ projects: [WORKTREE, FOLDER], timestamp: 0 }) });
    const opened: unknown[] = [];
    const onOpen = (e: Event) => opened.push((e as CustomEvent).detail);
    window.addEventListener("hermes:open-land-sheet", onOpen);
    try {
      const onClose = await open();
      const land = await screen.findByRole("button", { name: "Land…" });
      expect(document.querySelectorAll(".review-land-btn")).toHaveLength(1); // not the shared project folder
      fireEvent.click(land);
      expect(onClose).toHaveBeenCalled();
      expect(opened).toEqual([{ sessionId: "sess-a", projectId: "p1" }]);
    } finally {
      window.removeEventListener("hermes:open-land-sheet", onOpen);
    }
  });

  it("offers no Land when nothing is in a worktree of its own", async () => {
    backend({ git_status: () => ({ projects: [FOLDER], timestamp: 0 }) });
    await open();
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("git_status", { sessionId: "sess-a" }));
    expect(document.querySelector(".review-land-btn")).toBeNull();
  });

  it("has a Worktrees tab (disk use and cleanup)", async () => {
    await open();
    expect(screen.getByRole("tab", { name: "Worktrees" })).toBeInTheDocument();
  });

  it("a folder that is not a repository shows the plain empty state, not the raw error", async () => {
    backend({
      review_diff: () => {
        throw "fatal: not a git repository (or any of the parent directories): .git";
      },
    });
    await open();
    const empty = document.querySelector('.review-empty[data-empty="no-repository"]');
    expect(empty).toHaveTextContent("No git repository in this session's folders.");
    expect(document.querySelector(".review-error")).toBeNull();
    expect(document.body.textContent).not.toMatch(/fatal:/);
  });

  it("any other diff failure is still shown as an error", async () => {
    backend({
      review_diff: () => {
        throw "error: could not read index";
      },
    });
    await open();
    expect(document.querySelector(".review-error")).toHaveTextContent("error: could not read index");
    expect(document.querySelector('.review-empty[data-empty="no-repository"]')).toBeNull();
  });
});

// Regression audit item 4 (#126, #177): the git actions the replaced panels
// offered live on in the desk's Changes section.
describe("ReviewDesk: Changes", () => {
  const file = (path: string, area: "staged" | "unstaged" | "untracked", status = area === "untracked" ? "untracked" : "modified") => ({ path, area, status, old_path: null });
  const REPO = {
    project_id: "p1",
    project_name: "repo",
    project_path: "/fixture/repo",
    is_git_repo: true,
    branch: "hermes/task",
    remote_branch: null,
    ahead: 0,
    behind: 0,
    files: [file("src/app.js", "staged"), file("package-lock.json", "unstaged"), file("notes.txt", "untracked")],
    has_conflicts: false,
    stash_count: 0,
    error: null,
  };
  const BRANCHES = [
    { name: "hermes/task", is_current: true, is_remote: false, upstream: null, ahead: 0, behind: 0, last_commit_summary: null },
    { name: "main", is_current: false, is_remote: false, upstream: null, ahead: 0, behind: 0, last_commit_summary: null },
  ];
  const ok = () => ({ success: true, message: "" });
  const calls = (cmd: string) => h.invoke.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);
  const section = () => document.querySelector<HTMLElement>('.review-changes .git-project-section[data-project-id="p1"]')!;
  const row = (path: string) => section().querySelector<HTMLElement>(`.git-file-row[data-path="${path}"]`)!;
  const button = (path: string, name: string) => [...row(path).querySelectorAll("button")].find((b) => b.textContent === name)!;

  beforeEach(() => {
    backend({
      git_status: () => ({ projects: [REPO], timestamp: 0 }),
      get_settings: () => ({}),
      git_merge_status: () => ({ in_merge: false, conflicted_files: [], merge_message: null }),
      git_stage: ok,
      git_unstage: ok,
      git_discard_changes: ok,
      git_commit: () => ({ success: true, message: "Committed" }),
      git_push: () => ({ success: true, message: "Pushed to origin" }),
      git_pull: () => ({ success: true, message: "Already up to date" }),
      git_list_branches: () => BRANCHES,
      git_branches_ahead_behind: () => ({}),
      git_checkout_branch: () => ({ success: true, message: "Switched to main" }),
    });
  });

  it("sits at the top of the Review tab, per file, with history and stash left to the Repository tab", async () => {
    await open();
    await waitFor(() => expect(section()).toBeInTheDocument());
    const nav = document.querySelector(".review-nav")!;
    expect(nav.firstElementChild?.classList.contains("review-changes")).toBe(true);
    expect(screen.getByText("Changes", { selector: ".review-changes-title" })).toBeInTheDocument();
    expect(row("src/app.js").dataset.area).toBe("staged");
    expect(row("package-lock.json").dataset.area).toBe("unstaged");
    expect(section().querySelector(".git-view-toggle")).toBeNull();
    expect(section().querySelector('[data-testid="git-stash-stub"]')).toBeNull();
  });

  it("stages and unstages one file, and the review reloads", async () => {
    await open();
    await waitFor(() => expect(section()).toBeInTheDocument());
    const diffsBefore = calls("review_diff").length;
    fireEvent.click(button("package-lock.json", "Stage"));
    await waitFor(() => expect(calls("git_stage")).toEqual([{ sessionId: "sess-a", projectId: "p1", paths: ["package-lock.json"] }]));
    await waitFor(() => expect(calls("review_diff").length).toBeGreaterThan(diffsBefore));
    fireEvent.click(button("src/app.js", "Unstage"));
    await waitFor(() => expect(calls("git_unstage")).toEqual([{ sessionId: "sess-a", projectId: "p1", paths: ["src/app.js"] }]));
  });

  it("discards only after the confirm, and Cancel discards nothing", async () => {
    await open();
    await waitFor(() => expect(section()).toBeInTheDocument());
    fireEvent.click(button("package-lock.json", "Discard"));
    expect(calls("git_discard_changes")).toEqual([]);
    fireEvent.click(button("package-lock.json", "Cancel"));
    expect(calls("git_discard_changes")).toEqual([]);
    fireEvent.click(button("package-lock.json", "Discard"));
    fireEvent.click(button("package-lock.json", "Confirm"));
    await waitFor(() => expect(calls("git_discard_changes")).toEqual([{ sessionId: "sess-a", projectId: "p1", paths: ["package-lock.json"] }]));
  });

  it("commits with the message drafted from the turns, then pushes and pulls", async () => {
    await open();
    const box = await waitFor(() => {
      const el = section().querySelector<HTMLTextAreaElement>("textarea.git-commit-input")!;
      expect(el.value).toContain("2 turns:");
      return el;
    });
    // Subject from the branch, then one line per turn (as the Land sheet drafts it).
    expect(box.value.split("\n")[0]).toBe("Task");
    expect(box.value).toContain("- Turn 1: 1 file, +1 -1 (src/app.js)");
    expect(box.value).toContain("- Turn 2: 1 file, +1 -1 (package-lock.json)");
    expect(screen.getByText("Commit message (drafted from the turns)")).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "Fix the flaky login test" } });
    fireEvent.click([...section().querySelectorAll("button")].find((b) => b.textContent === "Commit")!);
    await waitFor(() => expect(calls("git_commit")).toHaveLength(1));
    expect(calls("git_commit")[0]).toMatchObject({ sessionId: "sess-a", projectId: "p1", message: "Fix the flaky login test" });
    expect(await screen.findByText("Committed successfully")).toBeInTheDocument();
    fireEvent.click(section().querySelector(".git-btn-push")!);
    await waitFor(() => expect(calls("git_push")).toEqual([{ sessionId: "sess-a", projectId: "p1", remote: null }]));
    fireEvent.click(section().querySelector(".git-btn-pull")!);
    await waitFor(() => expect(calls("git_pull")).toEqual([{ sessionId: "sess-a", projectId: "p1", remote: null }]));
  });

  it("without turns, the message is only a subject from the branch, not the branch's totals", async () => {
    clearFakeTurns();
    await open();
    const box = await waitFor(() => {
      const el = section().querySelector<HTMLTextAreaElement>("textarea.git-commit-input")!;
      expect(el.value).toBe("Task");
      return el;
    });
    expect(box.value).not.toContain("Changes:");
    expect(screen.getByText("Commit message")).toBeInTheDocument();
    expect(screen.queryByText("Commit message (drafted from the turns)")).toBeNull();
  });

  it("Escape in the commit message leaves the field and keeps the desk and the text; a second Escape closes", async () => {
    const onClose = await open();
    const box = await waitFor(() => section().querySelector<HTMLTextAreaElement>("textarea.git-commit-input")!);
    box.focus();
    fireEvent.change(box, { target: { value: "My own message" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(box);
    expect(box.value).toBe("My own message");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("switches the branch from the branch name", async () => {
    await open();
    await waitFor(() => expect(section()).toBeInTheDocument());
    fireEvent.click(section().querySelector(".git-project-branch-clickable")!);
    const main = await waitFor(() => {
      const el = [...document.querySelectorAll<HTMLElement>(".git-branch-item")].find((b) => b.textContent?.includes("main"));
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(main);
    await waitFor(() => expect(calls("git_checkout_branch")).toEqual([{ sessionId: "sess-a", projectId: "p1", name: "main" }]));
  });
});

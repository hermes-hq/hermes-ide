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

const session = (id: string, label: string, extra: Partial<SessionData> = {}): SessionData =>
  ({ id, label, working_directory: "/fixture/repo", mode: "terminal", phase: "running", ai_provider: "claude", ...extra }) as SessionData;
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

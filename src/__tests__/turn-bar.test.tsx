// @vitest-environment jsdom
/**
 * F20 — the turn bar under a terminal session (frontend side).
 *
 * Covers, with the Tauri bridge mocked:
 * - nothing renders for a session without turns
 * - one chip per turn with its diffstat; a summary-only turn is disabled
 * - a chip opens the turn's diff, rendered line by line
 * - "Restore to Tn" previews first (nothing restored yet), then restores
 *   on confirmation and shows "Restored to Tn"
 * - a `hermes:turn-ledger` event for this session reloads the list; one
 *   for another session does not
 *
 * The snapshots themselves (git, the private index, restore) are covered
 * in src-tauri/src/turn_ledger, and the whole journey on the real app in
 * e2e/app/scenarios/F20-turn-ledger.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, Handler>(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: Handler) => {
    h.listeners.set(name, handler);
    return Promise.resolve(h.unlisten);
  },
}));

import { TurnBar } from "../components/TurnBar";
import type { Turn } from "../agent/contract/turns";

const turn = (n: number, extra: Partial<Turn> = {}): Turn => ({
  sessionId: "s1",
  n,
  ref: `refs/hermes/s1/turn/${n}`,
  startedAt: 1000 * n,
  endedAt: 1000 * n + 500,
  diffstat: { files: n, insertions: 2 * n, deletions: n - 1 },
  ...extra,
});

let turns: Turn[] = [];

beforeEach(() => {
  h.invoke.mockReset();
  h.listeners.clear();
  turns = [];
  h.invoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "list_turns":
        return Promise.resolve(turns.filter((t) => t.sessionId === args.sessionId));
      case "get_turn_diff":
        return Promise.resolve({ turn: turn(args.n as number), patch: `diff --git a/x b/x\n@@ -1 +1 @@\n-hello\n+hello world\n` });
      case "preview_restore_turn":
        return Promise.resolve({ turn: turn(args.n as number), patch: "-after\n+before\n", diffstat: { files: 2, insertions: 1, deletions: 1 } });
      case "restore_turn":
        return Promise.resolve({ n: args.n, files: 2 });
      default:
        return Promise.reject(new Error(`unexpected command ${cmd}`));
    }
  });
});
afterEach(() => cleanup());

const chips = () => screen.queryAllByRole("button", { name: /^Turn \d+/ });

describe("TurnBar", () => {
  it("renders nothing for a session without turns", async () => {
    const { container } = render(<TurnBar sessionId="s1" />);
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("list_turns", { sessionId: "s1" }));
    expect(container.querySelector(".turn-bar")).toBeNull();
  });

  it("shows one chip per turn with its diffstat, and disables a summary-only turn", async () => {
    turns = [turn(1), turn(2), turn(3, { ref: "", degraded: true })];
    render(<TurnBar sessionId="s1" />);
    await waitFor(() => expect(chips()).toHaveLength(3));
    const [t1, , t3] = chips();
    expect(t1.getAttribute("data-turn-n")).toBe("1");
    expect(t1.textContent).toContain("T1");
    expect(t1.textContent).toContain("+2");
    expect(t1.textContent).toContain("−0");
    expect(t1.getAttribute("title")).toBe("Turn 1: 1 files changed, +2 −0");
    expect((t3 as HTMLButtonElement).disabled).toBe(true);
    expect((t1 as HTMLButtonElement).disabled).toBe(false);
    expect(t3.getAttribute("title")).toMatch(/summary only/);
  });

  it("a chip opens the turn's diff, line by line", async () => {
    turns = [turn(1)];
    render(<TurnBar sessionId="s1" />);
    await waitFor(() => expect(chips()).toHaveLength(1));
    fireEvent.click(chips()[0]);
    const sheet = await screen.findByRole("dialog");
    expect(sheet.getAttribute("data-sheet")).toBe("diff");
    expect(sheet.getAttribute("data-turn-n")).toBe("1");
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("get_turn_diff", { sessionId: "s1", n: 1 }));
    await waitFor(() => expect(sheet.querySelector(".turn-diff-line-add")?.textContent).toBe("+hello world"));
    expect(sheet.querySelector(".turn-diff-line-del")?.textContent).toBe("-hello");
    expect(sheet.querySelector(".turn-diff-line-hunk")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("restore previews first and only restores after confirmation", async () => {
    turns = [turn(1), turn(2)];
    render(<TurnBar sessionId="s1" />);
    await waitFor(() => expect(chips()).toHaveLength(2));
    fireEvent.click(chips()[0]);
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Restore to T1" }));
    await waitFor(() => expect(sheet.getAttribute("data-sheet")).toBe("restore"));
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("preview_restore_turn", { sessionId: "s1", n: 1 }));
    await waitFor(() => expect(sheet.querySelector(".turn-sheet-hint")?.getAttribute("data-preview-files")).toBe("2"));
    expect(sheet.querySelector(".turn-sheet-hint")?.textContent).toMatch(/Restoring to T1 changes 2 files/);
    expect(h.invoke).not.toHaveBeenCalledWith("restore_turn", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("restore_turn", { sessionId: "s1", n: 1 }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("status").textContent).toBe("Restored to T1");
  });

  it("cancel in the preview restores nothing", async () => {
    turns = [turn(1)];
    render(<TurnBar sessionId="s1" />);
    await waitFor(() => expect(chips()).toHaveLength(1));
    fireEvent.click(chips()[0]);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Restore to T1" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(h.invoke).not.toHaveBeenCalledWith("restore_turn", expect.anything());
  });

  it("reloads when the backend records a turn for this session, not for another", async () => {
    turns = [turn(1)];
    render(<TurnBar sessionId="s1" />);
    await waitFor(() => expect(chips()).toHaveLength(1));
    await waitFor(() => expect(h.listeners.has("hermes:turn-ledger")).toBe(true));
    const listCalls = () => h.invoke.mock.calls.filter((c) => c[0] === "list_turns").length;
    const before = listCalls();
    turns = [turn(1), turn(2)];
    await act(async () => {
      h.listeners.get("hermes:turn-ledger")!({ payload: { sessionId: "other", turn: turn(2) } });
    });
    expect(listCalls()).toBe(before);
    expect(chips()).toHaveLength(1);
    await act(async () => {
      h.listeners.get("hermes:turn-ledger")!({ payload: { sessionId: "s1", turn: turn(2) } });
    });
    await waitFor(() => expect(chips()).toHaveLength(2));
    await act(async () => {
      h.listeners.get("hermes:turn-ledger")!({ payload: { sessionId: "s1", restoredTo: 1 } });
    });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Restored to T1"));
  });
});

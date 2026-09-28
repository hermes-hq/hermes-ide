// @vitest-environment jsdom
/**
 * F27 Done-When chip: what a person sees in the pane header for each result,
 * and what its two buttons do.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider";
import { DoneWhenChip, chipState } from "../components/DoneWhenChip";
import { _resetDoneWhenStoreForTest, recordDoneWhen, setDoneWhenRunning } from "../doneWhen/store";
import { _resetDoneWhenControllerForTest, startDoneWhen } from "../doneWhen/controller";
import { _resetSessionEventStoreForTest } from "../agent/contract/sessionEventStore";
import { parseCheckRecord, type CheckRecord, type RunOutcome } from "../doneWhen/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function record(state: string, extra: Record<string, unknown> = {}, run: Record<string, unknown> = {}): CheckRecord {
  const parsed = parseCheckRecord({
    session_id: "s1",
    turn: 1,
    check_failed: false,
    failed_turns: 0,
    hook: false,
    ...extra,
    run: {
      state,
      trigger: "turn_end",
      source: { kind: "worktree", path: ".hermes/worktree.toml" },
      error: state === "error" ? "worktree.toml can't be read (line 2): expected key = value" : null,
      commands:
        state === "error"
          ? []
          : [
              { command: "npm run lint", exit_code: 0, timed_out: false, duration_ms: 3, output_tail: "" },
              { command: "npm test", exit_code: state === "failed" ? 1 : 0, timed_out: false, duration_ms: 5, output_tail: "1 failing" },
            ],
      started_at: 1,
      duration_ms: 8,
      ...run,
    },
  });
  if (!parsed) throw new Error("bad fixture");
  return parsed;
}

let container: HTMLDivElement;
let root: Root;
let runMock: ReturnType<typeof vi.fn>;
let writeMock: ReturnType<typeof vi.fn>;
let shellForeground: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  _resetDoneWhenStoreForTest();
  _resetDoneWhenControllerForTest();
  _resetSessionEventStoreForTest();
  runMock = vi.fn(async (): Promise<RunOutcome> => ({ skipped: null, record: null }));
  writeMock = vi.fn(async () => {});
  // An agent owns the terminal unless a test says otherwise.
  shellForeground = vi.fn(async () => false);
  await startDoneWhen({
    listen: () => Promise.resolve(() => {}),
    run: runMock,
    write: writeMock,
    shellForeground,
    now: () => 7,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <DoneWhenChip sessionId="s1" />
      </I18nProvider>,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const chip = () => container.querySelector<HTMLButtonElement>(".done-when-chip");
const click = (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

describe("DoneWhenChip", () => {
  it("shows nothing until a check ran, then what it found", () => {
    expect(chip()).toBeNull();
    act(() => setDoneWhenRunning("s1", true));
    expect(chip()?.textContent).toBe("checking…");
    expect(chip()?.dataset.state).toBe("running");
    act(() => {
      recordDoneWhen(record("passed"));
    });
    expect(chip()?.textContent).toBe("tests ✓");
    expect(chip()?.dataset.state).toBe("passed");
    expect(chip()?.title).toBe("Done-When checks from .hermes/worktree.toml");
    act(() => {
      recordDoneWhen(record("failed"));
    });
    expect(chip()?.textContent).toBe("checks ✗ 1/2");
    act(() => {
      recordDoneWhen(record("failed", { check_failed: true, failed_turns: 3 }));
    });
    expect(chip()?.textContent).toBe("check failed");
    expect(chip()?.dataset.state).toBe("check_failed");
    act(() => {
      recordDoneWhen(record("error"));
    });
    expect(chip()?.textContent).toBe("checks can't run");
  });

  it("while the agent's Stop hook sends it back, the chip counts the retries and offers no send", () => {
    act(() => {
      recordDoneWhen(record("failed", { hook: true }, { trigger: "stop_hook", attempt: 2, max_attempts: 3, blocking: true, final: false }));
    });
    expect(chip()?.textContent).toBe("checks ✗ · retry 2/3");
    click(chip());
    expect(container.querySelector(".done-when-send")).toBeNull();
    expect(container.querySelector(".done-when-note")?.textContent).toContain("at most 3 times");
  });

  it("opens a list of the checks with the failing output, and sends the failures back on click", async () => {
    act(() => {
      recordDoneWhen(record("failed"));
    });
    click(chip());
    await act(async () => {});
    const rows = [...container.querySelectorAll(".done-when-command")];
    expect(rows.map((r) => r.getAttribute("data-ok"))).toEqual(["true", "false"]);
    expect(rows[1].querySelector(".done-when-command-result")?.textContent).toBe("exit 1");
    expect(rows[1].querySelector(".done-when-output")?.textContent).toBe("1 failing");
    expect(rows[0].querySelector(".done-when-output")).toBeNull();
    const send = container.querySelector(".done-when-send");
    expect(send?.textContent).toBe("Send failures back");
    await act(async () => {
      send?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".done-when-send")?.textContent).toBe("Sent to the agent");
  });

  it("with the shell at its prompt (the agent quit) it offers no send and says why", async () => {
    shellForeground.mockResolvedValue(true);
    act(() => {
      recordDoneWhen(record("failed"));
    });
    click(chip());
    await act(async () => {});
    expect(shellForeground).toHaveBeenCalledWith("s1");
    expect(container.querySelector(".done-when-send")).toBeNull();
    expect(container.querySelector(".done-when-note-no-agent")?.textContent).toBe(
      "No agent is running in this terminal. Start it again to send it the failures.",
    );
    expect(container.querySelector(".done-when-rerun")).not.toBeNull();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("an agent that quits after the list opened: the click sends nothing and the button goes", async () => {
    act(() => {
      recordDoneWhen(record("failed"));
    });
    click(chip());
    await act(async () => {});
    const send = container.querySelector(".done-when-send");
    expect(send).not.toBeNull();
    shellForeground.mockResolvedValue(true);
    await act(async () => {
      send?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(writeMock).not.toHaveBeenCalled();
    expect(container.querySelector(".done-when-send")).toBeNull();
    expect(container.querySelector(".done-when-note-no-agent")).not.toBeNull();
  });

  it("Run checks again asks for a manual run", async () => {
    act(() => {
      recordDoneWhen(record("passed"));
    });
    click(chip());
    expect(container.querySelector(".done-when-send")).toBeNull();
    await act(async () => {
      container.querySelector(".done-when-rerun")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(runMock).toHaveBeenCalledWith("s1", "manual", null);
  });

  it("Escape closes the list", () => {
    act(() => {
      recordDoneWhen(record("failed"));
    });
    click(chip());
    expect(container.querySelector(".done-when-popover")).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelector(".done-when-popover")).toBeNull();
  });
});

describe("chipState", () => {
  it("maps every result", () => {
    expect(chipState(null, false)).toBeNull();
    expect(chipState(record("none", {}, { commands: [] }), false)).toBeNull();
    expect(chipState(record("passed"), true)).toBe("running");
  });
});

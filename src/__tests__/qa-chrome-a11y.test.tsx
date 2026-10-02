// @vitest-environment jsdom
/**
 * QA chrome & accessibility fixes, driven through the DOM:
 *   - useFocusTrap (CHAOS-13): a modal takes the keyboard, keeps Tab inside,
 *     closes on Esc unless a field inside handled it, keeps a terminal from
 *     taking the keyboard back, and gives it back when it closes;
 *   - the agent doctor (NEWCOMER-08/14, ACC-09): buttons name their agent,
 *     the columns are explained, "Copied" goes back, a CLI that cannot
 *     start says so and offers no Sign in;
 *   - the Usage and Search panels' empty states (NEWCOMER-11/13);
 *   - the refusal banner naming Codex's own default model (ACC-06).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { useRef, useState } from "react";
import type { DoctorRow } from "../api/doctor";

const h = vi.hoisted(() => ({ doctor: [] as DoctorRow[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "agent_doctor") return h.doctor;
    throw new Error(`unexpected ${cmd}`);
  }),
}));

import { useFocusTrap } from "../hooks/useFocusTrap";
import { AgentDoctor, COPIED_FOR_MS, doctorAgentName } from "../components/AgentDoctor";
import { usageEmptyText, usageSubtitle } from "../components/UsagePanel";
import { formatResultCount, searchBlocker } from "../components/SearchPanel";
import { refusedModelName, rejectionView } from "../agent/capabilities/rejection";
import { I18nProvider } from "../i18n/I18nProvider";
import { translate, translateIn } from "../i18n/registry";
import { dePack } from "../i18n/packs/de";
import { __resetDoctorForTest } from "../launcher/doctorStore";

const t = (k: string, v?: Record<string, string | number>) => translate(k, v);

// jsdom lays nothing out: every element gets a box, so it counts as on screen.
const realRects = Element.prototype.getClientRects;
beforeEach(() => {
  Element.prototype.getClientRects = function () {
    return [{ width: 10, height: 10 }] as unknown as DOMRectList;
  };
});
afterEach(() => {
  Element.prototype.getClientRects = realRects;
  cleanup();
  document.body.innerHTML = "";
});

function key(target: Element | null, init: KeyboardEventInit) {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  (target ?? document.body).dispatchEvent(ev);
  return ev;
}

function Dialog({ onClose, withField = false }: { onClose: () => void; withField?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { onEscape: onClose, initialFocus: ".start" });
  return (
    <div role="dialog" aria-modal="true">
      <div ref={ref} className="panel">
        <button type="button" className="first">First</button>
        <button type="button" className="start">Start here</button>
        {withField && (
          <input
            className="field"
            onKeyDown={(e) => {
              if (e.key === "Escape") e.preventDefault();
            }}
          />
        )}
        <button type="button" className="last">Last</button>
      </div>
    </div>
  );
}

function Host({ withField = false }: { withField?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="xterm">
        <textarea className="xterm-helper-textarea" aria-label="terminal" />
      </div>
      <button type="button" className="opener" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && <Dialog onClose={() => setOpen(false)} withField={withField} />}
    </>
  );
}

describe("useFocusTrap", () => {
  it("takes the keyboard from the terminal, keeps Tab inside, and gives it back on Esc", async () => {
    render(<Host />);
    const terminal = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
    terminal.focus();
    // Opened from the menu while the terminal has the keyboard: the dialog
    // takes it (on its starting control), and the terminal cannot take it back.
    act(() => {
      (document.querySelector(".opener") as HTMLButtonElement).click();
    });
    expect(document.activeElement).toHaveClass("start");
    act(() => terminal.focus());
    expect(document.activeElement).toHaveClass("start");

    // Tab from the last control comes back to the first, Shift+Tab the other way.
    (document.querySelector(".last") as HTMLElement).focus();
    expect(key(document.activeElement, { key: "Tab" }).defaultPrevented).toBe(true);
    expect(document.activeElement).toHaveClass("first");
    key(document.activeElement, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toHaveClass("last");

    // The terminal cannot take the keyboard back while it is open.
    act(() => terminal.focus());
    expect(document.querySelector(".panel")!.contains(document.activeElement)).toBe(true);

    act(() => {
      key(document.activeElement, { key: "Escape" });
    });
    expect(document.querySelector(".panel")).toBeNull();
  });

  it("keeps the terminals inert while it is open (no focus events in a window in the background)", () => {
    render(<Host />);
    const xterm = document.querySelector<HTMLElement>(".xterm")!;
    act(() => {
      (document.querySelector(".opener") as HTMLButtonElement).click();
    });
    expect(xterm).toHaveAttribute("inert");
    act(() => {
      key(document.activeElement, { key: "Escape" });
    });
    expect(xterm).not.toHaveAttribute("inert");
  });

  it("gives the keyboard back to where it was when the dialog closes", () => {
    function Wrapper() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" className="before">Before</button>
          {open && <Dialog onClose={() => setOpen(false)} />}
        </>
      );
    }
    const before = document.createElement("button");
    document.body.appendChild(before);
    before.focus();
    render(<Wrapper />);
    expect(document.activeElement).toHaveClass("start");
    act(() => {
      key(document.activeElement, { key: "Escape" });
    });
    expect(document.activeElement).toBe(before);
  });

  it("an Esc a field inside handled (a rename being cancelled) does not close the dialog", () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} withField />);
    const field = document.querySelector<HTMLInputElement>(".field")!;
    field.focus();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    (document.querySelector(".start") as HTMLElement).focus();
    act(() => {
      key(document.activeElement, { key: "Escape" });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("only the dialog opened last reacts to keys", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <>
        <Dialog onClose={outer} />
        <Dialog onClose={inner} />
      </>,
    );
    act(() => {
      key(document.activeElement, { key: "Escape" });
    });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});

function row(id: string, name: string, over: Partial<DoctorRow> = {}): DoctorRow {
  return { id, name, installed: true, version: "1.2.3", min_version: null, version_ok: null, signed_in: "yes", signals: "exact", resume: true, retired: false, retired_note: null, beta: false, ...over };
}

describe("AgentDoctor", () => {
  beforeEach(() => __resetDoctorForTest());

  it("names each button's agent, explains its columns, and says when a CLI cannot start", async () => {
    h.doctor = [
      row("claude", "Claude Code", { signed_in: "no" }),
      row("codex", "Codex", { version: null, signed_in: "unknown", broken: "env: node: No such file or directory" }),
      row("gemini", "Gemini CLI", { installed: false, version: null, signed_in: "unknown" }),
      row("goose", "goose", { installed: false, version: null, signed_in: "unknown" }),
      row("hermes-agent", "Hermes Agent", { installed: false, version: null, signed_in: "unknown" }),
    ];
    render(
      <I18nProvider>
        <AgentDoctor onSignIn={() => {}} />
      </I18nProvider>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByRole("button", { name: "Sign in to Claude Code" })).toBeInTheDocument();
    const copies = screen.getAllByRole("button", { name: /^Copy install command for / }).map((b) => b.getAttribute("aria-label"));
    expect(copies).toEqual(["Copy install command for Gemini CLI", "Copy install command for goose", "Copy install command for Hermes Agent (Nous Research)"]);
    // A CLI that cannot start: why, and no Sign in.
    const codex = document.querySelector('tr[data-agent-id="codex"]')!;
    expect(codex).toHaveAttribute("data-broken", "true");
    expect(codex.querySelector(".agent-doctor-broken")).toHaveTextContent("Codex is installed but fails to start: env: node: No such file or directory. Check your PATH or reinstall.");
    expect(codex.querySelector(".agent-doctor-sign-in")).toBeNull();
    // The columns and their legend.
    const ths = [...document.querySelectorAll("th")].map((th) => ({ text: th.textContent, title: th.getAttribute("title") }));
    expect(ths.find((x) => x.text === "Status updates")?.title).toContain("Exact = the agent tells Hermes when it needs you");
    expect(ths.find((x) => x.text === "Can resume")?.title).toBe("Can resume: reopen the conversation after a restart.");
    const legend = document.querySelector(".agent-doctor-legend")!;
    expect(legend.textContent).toBe(`${t("doctor.legend.signals")} ${t("doctor.legend.resume")}`);
    expect(document.querySelector("table")!.getAttribute("aria-describedby")).toBe(legend.id);
    expect(document.querySelector('tr[data-agent-id="hermes-agent"] .agent-doctor-name')).toHaveTextContent("Hermes Agent (Nous Research)");
  });

  it("\"Copied\" goes back after two seconds; Settings can hide its own Check again", async () => {
    h.doctor = [row("gemini", "Gemini CLI", { installed: false, version: null, signed_in: "unknown" })];
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
    render(
      <I18nProvider>
        <AgentDoctor onSignIn={() => {}} showRecheck={false} />
      </I18nProvider>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(document.querySelector(".agent-doctor-recheck")).toBeNull();
    vi.useFakeTimers();
    try {
      const copy = document.querySelector(".agent-doctor-copy")!;
      await act(async () => {
        fireEvent.click(copy);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(document.querySelector(".agent-doctor-copy")).toHaveTextContent("Copied");
      expect(document.querySelector(".agent-doctor-copy")).toHaveAttribute("aria-label", "Install command for Gemini CLI copied");
      act(() => {
        vi.advanceTimersByTime(COPIED_FOR_MS + 10);
      });
      expect(document.querySelector(".agent-doctor-copy")).toHaveTextContent("Copy install command");
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells Nous Research's agent apart from the app; other names stay", () => {
    expect(doctorAgentName({ id: "hermes-agent", name: "Hermes Agent" })).toBe("Hermes Agent (Nous Research)");
    expect(doctorAgentName({ id: "codex", name: "Codex" })).toBe("Codex");
  });
});

describe("the Usage panel's empty state", () => {
  const shell = { ai_provider: null, detected_agent: null, mode: "terminal" as const };
  it("a plain shell is a shell", () => {
    expect(usageSubtitle(shell, t)).toBe("Shell");
    expect(usageEmptyText(shell, t)).toBe("No agent in this session.");
  });
  it("a Claude task in a terminal says where it runs and how to get usage", () => {
    const claude = { ...shell, ai_provider: "claude" };
    expect(usageSubtitle(claude, t)).toBe("Claude Code · terminal");
    expect(usageSubtitle({ ...claude, mode: "agent" as const }, t)).toBe("Claude Code · live");
    expect(usageEmptyText(claude, t)).toBe(
      "Plan usage and limits show for tasks that run in Agent view. This task runs in a terminal. Start the next task with + options › Runs in › Agent view.",
    );
  });
  it("another agent: usage comes from Claude Code tasks in Agent view only", () => {
    const codex = { ...shell, ai_provider: "codex" };
    expect(usageSubtitle(codex, t)).toBe("Codex · terminal");
    expect(usageEmptyText(codex, t)).toBe("Plan usage and limits show only for Claude Code tasks that run in Agent view. Codex does not report them to Hermes.");
  });
});

describe("the Search panel's empty state", () => {
  it("says what is missing: a session, then a project", () => {
    expect(searchBlocker(null, null)).toBe("no-session");
    expect(searchBlocker("s1", null)).toBe("no-project");
    expect(searchBlocker("s1", "p1")).toBeNull();
    // While the session's projects load, nothing is missing yet.
    expect(searchBlocker("s1", null, false)).toBe("loading");
    expect(searchBlocker(null, null, false)).toBe("no-session");
    expect(t("search.noSession")).toBe("Open a session to search its files.");
    expect(t("search.noProject")).toBe("This session has no project. Add one to search its files.");
  });
  it("counts results in the person's language", () => {
    expect(formatResultCount(1, 1, t)).toBe("1 result in 1 file");
    expect(formatResultCount(3, 2, t)).toBe("3 results in 2 files");
    const de = (k: string, v?: Record<string, string | number>) => translateIn(dePack, k, v);
    expect(formatResultCount(3, 2, de)).toBe("3 Treffer in 2 Dateien");
  });
});

describe("a refused default model is named", () => {
  const codexMessage = '{"type":"error","message":"stream error: unexpected status 404 Not Found: The model `gpt-5.2-codex` does not exist or you do not have access to it."}';
  it("reads the model from the CLI's words", () => {
    expect(refusedModelName(codexMessage)).toBe("gpt-5.2-codex");
    expect(refusedModelName("The 'gpt-5.2-codex' model is not supported when using Codex with a ChatGPT account.")).toBe("gpt-5.2-codex");
    expect(refusedModelName("Not logged in")).toBeNull();
    expect(refusedModelName(undefined)).toBeNull();
  });
  it("the banner says which model and where it is set", () => {
    const v = rejectionView({ reason: "model", suggestion: "retry-default", vendorMessage: codexMessage }, "Codex", { modelId: null, accountId: null }, null, "default", "~/.codex/config.toml");
    expect(t(v.titleKey, v.titleValues)).toBe("Codex's default model, gpt-5.2-codex (set in ~/.codex/config.toml), isn't available on your default account");
    expect(v.actions.map((a) => a.kind)).not.toContain("retry-default");
    // Another account's own config is not ~/.codex: the model, without the place.
    const w = rejectionView({ reason: "model", suggestion: "retry-default", vendorMessage: codexMessage }, "Codex", { modelId: null, accountId: "work" }, null, "default", "~/.codex/config.toml");
    expect(t(w.titleKey, w.titleValues)).toBe("Codex's default model, gpt-5.2-codex, isn't available on your work account");
  });
});

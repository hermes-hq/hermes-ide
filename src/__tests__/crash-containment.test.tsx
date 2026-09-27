// @vitest-environment jsdom
/**
 * Crash containment: a render error stays inside the pane or block it
 * happened in, the rest of the window keeps rendering, and Reload brings
 * the broken part back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("../api/settings", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));

// A text block whose text is "BOOM" throws while rendering — stands in for
// any malformed block the agent could send.
vi.mock("../agent/blocks/TextBlock", async (importOriginal) => {
  const real = await importOriginal<typeof import("../agent/blocks/TextBlock")>();
  return {
    ...real,
    TextBlock: (props: Parameters<typeof real.TextBlock>[0]) => {
      if (props.block.text === "BOOM") throw new Error("malformed block");
      return real.TextBlock(props);
    },
  };
});

import { ContainedErrorBoundary } from "../components/ContainedErrorBoundary";
import { registerLanguagePack, setLanguage } from "../i18n/registry";
import { dePack } from "../i18n/packs/de";
import { CrashProbe, armCrash, isCrashArmed } from "../components/CrashProbe";
import { MessageRow } from "../agent/AgentSessionView";
import type { RenderedMessage } from "../agent/messageStore";
import type { ToolResultBlockData } from "../agent/types";

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // React reports every caught render error; keep the test output readable.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  consoleError.mockRestore();
});

function Pane({ id, children }: { id: string; children?: ReactNode }) {
  return (
    <section data-testid={`pane-${id}`}>
      <ContainedErrorBoundary scope="pane" label={`session ${id}`}>
        <CrashProbe target={`pane:${id}`} />
        {children ?? <Counter id={id} />}
      </ContainedErrorBoundary>
    </section>
  );
}

function Counter({ id }: { id: string }) {
  const [n, setN] = useState(0);
  return (
    <button type="button" onClick={() => setN((v) => v + 1)}>
      {id} clicked {n}
    </button>
  );
}

describe("pane-level containment", () => {
  it("a crash in one pane shows an error card there while the other pane keeps working", async () => {
    render(
      <>
        <Pane id="a" />
        <Pane id="b" />
      </>,
    );
    fireEvent.click(screen.getByText("b clicked 0"));
    expect(screen.getByText("b clicked 1")).toBeTruthy();

    act(() => armCrash("pane:a"));

    const paneA = screen.getByTestId("pane-a");
    const card = paneA.querySelector('[data-error-scope="pane"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("This pane stopped working: session a");
    expect(card!.textContent).toContain("Test crash requested for pane:a");
    expect(paneA.textContent).not.toContain("a clicked");

    // Pane b is untouched: still mounted with its state, still interactive.
    expect(screen.getByTestId("pane-b").querySelector('[data-error-scope]')).toBeNull();
    fireEvent.click(screen.getByText("b clicked 1"));
    expect(screen.getByText("b clicked 2")).toBeTruthy();
  });

  it("Reload pane remounts the crashed pane and it works again", async () => {
    render(
      <>
        <Pane id="a" />
        <Pane id="b" />
      </>,
    );
    act(() => armCrash("pane:a"));
    expect(screen.getByRole("alert")).toBeTruthy();

    // The test crash is one-shot: it disarms once React has given up on it.
    await act(() => new Promise((r) => setTimeout(r, 5)));
    expect(isCrashArmed("pane:a")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Reload pane" }));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByText("a clicked 0"));
    expect(screen.getByText("a clicked 1")).toBeTruthy();
  });

  it("offers the extra actions it is given (e.g. Close pane) next to Reload", () => {
    const onClose = vi.fn();
    function Broken(): ReactNode {
      throw new Error("x");
    }
    render(
      <ContainedErrorBoundary scope="pane" actions={<button onClick={onClose}>Close pane</button>}>
        <Broken />
      </ContainedErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close pane" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("speaks the interface language, naming the session", async () => {
    const pack = registerLanguagePack(dePack);
    await setLanguage("de");
    try {
      render(<Pane id="l10n" />);
      act(() => armCrash("pane:l10n"));
      const card = await screen.findByRole("alert");
      expect(card.textContent).toContain("Dieses Pane funktioniert nicht mehr: session l10n");
      expect(card.textContent).toContain("Andere Panes sind nicht betroffen.");
      expect(screen.getByRole("button", { name: "Pane neu laden" })).toBeTruthy();
    } finally {
      await setLanguage("en");
      pack.dispose();
    }
  });

  it("app-level Reload keeps state that lives above the boundary (the session store)", () => {
    let crash = true;
    function Shell(): ReactNode {
      if (crash) throw new Error("shell broke");
      return <p>shell ok</p>;
    }
    function Store() {
      const [sessions] = useState(() => ["s1", "s2"]);
      return (
        <div>
          <span data-testid="sessions">{sessions.join(",")}</span>
          <ContainedErrorBoundary scope="app">
            <Shell />
          </ContainedErrorBoundary>
        </div>
      );
    }
    render(<Store />);
    expect(screen.getByRole("alert").textContent).toContain("Your sessions are still running");
    crash = false;
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(screen.getByText("shell ok")).toBeTruthy();
    expect(screen.getByTestId("sessions").textContent).toBe("s1,s2");
  });
});

describe("block-level containment in the agent view", () => {
  const noResults = new Map<string, ToolResultBlockData>();
  const message = (id: string, texts: string[]): RenderedMessage => ({
    id,
    role: "assistant",
    blocks: texts.map((text) => ({ type: "text" as const, text })),
    timestamp: 1700000000000,
  });

  it("a block that throws becomes an error card; its siblings and other messages still render", () => {
    render(
      <div>
        <MessageRow message={message("m1", ["first block", "BOOM", "third block"])} toolResults={noResults} />
        <MessageRow message={message("m2", ["next message"])} toolResults={noResults} />
      </div>,
    );
    const cards = document.querySelectorAll('[data-error-scope="block"]');
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain("This block could not be shown");
    expect(cards[0].textContent).toContain("malformed block");
    expect(cards[0].closest('[data-message-id="m1"]')).not.toBeNull();

    const page = document.body.textContent ?? "";
    expect(page).toContain("first block");
    expect(page).toContain("third block");
    expect(page).toContain("next message");
  });
});

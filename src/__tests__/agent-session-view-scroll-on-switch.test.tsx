// @vitest-environment jsdom
/**
 * Regression — #327 / #328: switching tabs opens an agent conversation
 * scrolled to the TOP instead of at the latest message.
 *
 * Two paths hit it:
 *   1. Remount (switch to a terminal tab and back, file preview, …):
 *      the scroll listener ran `onScroll()` on mount while scrollTop was
 *      still 0, flagged the view as "not at bottom", and the rAF
 *      auto-scroll then refused to move.
 *   2. In-place session swap (agent tab → agent tab in the same pane):
 *      the component is reused, so the previous session's sticky flag
 *      (and scroll offset) carried over to the new conversation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("../state/SessionContext", () => ({
  useSession: () => ({
    sendAgentEnvelope: vi.fn(async () => {}),
    state: { sessions: {} },
  }),
}));

import { AgentSessionView } from "../agent/AgentSessionView";
import {
  getOrCreateAgentSessionStore,
  _resetAgentSessionStoresForTest,
} from "../agent/agentSessionStore";

const SCROLL_HEIGHT = 5000;
const CLIENT_HEIGHT = 400;
// Mutable so a test can simulate content growing mid-stream.
let scrollHeight = SCROLL_HEIGHT;

function pushMessage(sessionId: string, text: string) {
  const store = getOrCreateAgentSessionStore(sessionId, async () => () => {});
  store.injectEvent({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    session_id: sessionId,
  });
}

function seedHistory(sessionId: string) {
  for (let i = 0; i < 5; i++) pushMessage(sessionId, `msg ${i}`);
}

function scroller(container: HTMLElement): HTMLElement {
  const el = container.querySelector(".agent-session-scroll");
  if (!el) throw new Error("scroll container not rendered");
  return el as HTMLElement;
}

async function flushFrames() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

let origScrollHeight: PropertyDescriptor | undefined;
let origClientHeight: PropertyDescriptor | undefined;

beforeEach(() => {
  // jsdom has no layout — give every element a tall scrollable body.
  origScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  scrollHeight = SCROLL_HEIGHT;
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => CLIENT_HEIGHT });
});

afterEach(() => {
  cleanup();
  _resetAgentSessionStoresForTest();
  if (origScrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", origScrollHeight);
  if (origClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", origClientHeight);
});

describe("AgentSessionView — opens at the latest message on tab switch", () => {
  it("scrolls to the bottom when remounting a session with existing history", async () => {
    seedHistory("sess-remount");
    const view = render(<AgentSessionView sessionId="sess-remount" workspacePathCount={1} />);
    await flushFrames();
    expect(scroller(view.container).scrollTop).toBe(SCROLL_HEIGHT);
  });

  it("scrolls to the bottom when the pane swaps to another session in place", async () => {
    seedHistory("sess-a");
    seedHistory("sess-b");
    const view = render(<AgentSessionView sessionId="sess-a" workspacePathCount={1} />);
    await flushFrames();

    // User scrolls up to re-read history in session A.
    const el = scroller(view.container);
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));

    view.rerender(<AgentSessionView sessionId="sess-b" workspacePathCount={1} />);
    await flushFrames();
    expect(scroller(view.container).scrollTop).toBe(SCROLL_HEIGHT);
  });

  it("keeps following when content grows before our own scroll event lands", async () => {
    // Scroll events are async: the rAF sets scrollTop = scrollHeight, and
    // the resulting `scroll` event fires a frame later.  If streaming adds
    // a tall block in that gap, the event sees distance > threshold even
    // though the user never touched anything — that must NOT unstick.
    seedHistory("sess-race");
    const view = render(<AgentSessionView sessionId="sess-race" workspacePathCount={1} />);
    await flushFrames();
    const el = scroller(view.container);
    expect(el.scrollTop).toBe(SCROLL_HEIGHT);

    scrollHeight = SCROLL_HEIGHT + 600; // tool card / diff lands
    el.dispatchEvent(new Event("scroll")); // echo of our programmatic scroll

    act(() => pushMessage("sess-race", "next chunk"));
    await flushFrames();
    expect(el.scrollTop).toBe(SCROLL_HEIGHT + 600);
  });

  it("stops following once the user scrolls up", async () => {
    seedHistory("sess-up");
    const view = render(<AgentSessionView sessionId="sess-up" workspacePathCount={1} />);
    await flushFrames();
    const el = scroller(view.container);

    el.scrollTop = 1000;
    el.dispatchEvent(new Event("scroll"));

    scrollHeight = SCROLL_HEIGHT + 600;
    act(() => pushMessage("sess-up", "next chunk"));
    await flushFrames();
    expect(el.scrollTop).toBe(1000);
  });
});

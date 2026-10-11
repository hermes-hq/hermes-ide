// @vitest-environment jsdom
/**
 * Unsent composer images belong to the Agent-view session they were added
 * in. The composer is mounted once for every session, and its images used
 * to follow the user to another Agent-view session and go out with that
 * session's next message. A switch to a terminal session and back still
 * keeps them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const submitAgentMessageMock = vi.fn(async (..._args: unknown[]) => {});

interface FakeSessionState {
  activeSessionId: string;
  sessions: Record<string, { id: string; mode: string }>;
  composers: Record<string, { draft: string; height: number; expanded: boolean }>;
}

const fakeState: FakeSessionState = {
  activeSessionId: "a",
  sessions: {
    a: { id: "a", mode: "agent" },
    b: { id: "b", mode: "agent" },
    t: { id: "t", mode: "terminal" },
  },
  composers: {
    a: { draft: "from a", height: 120, expanded: true },
    b: { draft: "from b", height: 120, expanded: true },
  },
};

vi.mock("../state/SessionContext", () => ({
  useSession: () => ({
    state: fakeState,
    dispatch: vi.fn(),
    switchAgentModel: vi.fn(),
    switchAgentPermissionMode: vi.fn(),
    switchAgentEffort: vi.fn(),
    submitAgentMessage: submitAgentMessageMock,
  }),
  useComposer: (sid: string) => fakeState.composers[sid] ?? { draft: "", height: 120, expanded: true },
}));
vi.mock("../agent/useAgentInit", () => ({ useAgentInit: () => null }));
vi.mock("../agent/useAgentPrewarm", () => ({ useAgentPrewarm: () => ({ slashCommands: [], catalog: [] }) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../api/agent", () => ({ readImageForAttachment: vi.fn() }));

import { SessionComposer } from "../components/SessionComposer";
import { I18nProvider } from "../i18n/I18nProvider";

const textarea = (c: HTMLElement) => c.querySelector("textarea.session-composer-input") as HTMLTextAreaElement;
const sentAttachments = () => (submitAgentMessageMock.mock.calls.at(-1)?.[2] ?? []) as unknown[];

async function pasteImage(c: HTMLElement) {
  const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
  fireEvent.paste(textarea(c), {
    clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }] },
  });
  await waitFor(() => expect(c.querySelector("[data-has-attachments='true']")).not.toBeNull());
}

async function send(c: HTMLElement) {
  await act(async () => { fireEvent.keyDown(textarea(c), { key: "Enter" }); });
}

beforeEach(() => {
  submitAgentMessageMock.mockClear();
  fakeState.activeSessionId = "a";
});
afterEach(() => cleanup());

describe("composer images stay with their session", () => {
  it("an image added in A is not sent with B's message, and comes back in A", async () => {
    const ui = () => <I18nProvider><SessionComposer /></I18nProvider>;
    const { container, rerender } = render(ui());
    await pasteImage(container);

    fakeState.activeSessionId = "b";
    rerender(ui());
    await send(container);
    expect(submitAgentMessageMock.mock.calls.at(-1)?.[0]).toBe("b");
    expect(sentAttachments()).toHaveLength(0);

    fakeState.activeSessionId = "a";
    rerender(ui());
    await send(container);
    expect(submitAgentMessageMock.mock.calls.at(-1)?.[0]).toBe("a");
    expect(sentAttachments()).toHaveLength(1);
  });

  it("a switch while A's message is sending keeps B's image and does not bring A's back", async () => {
    const ui = () => <I18nProvider><SessionComposer /></I18nProvider>;
    const { container, rerender } = render(ui());
    await pasteImage(container);

    let finishSend = () => {};
    submitAgentMessageMock.mockImplementationOnce(() => new Promise<void>((r) => { finishSend = r; }));
    await send(container);

    fakeState.activeSessionId = "b";
    rerender(ui());
    await pasteImage(container);
    await act(async () => { finishSend(); });

    await send(container);
    expect(submitAgentMessageMock.mock.calls.at(-1)?.[0]).toBe("b");
    expect(sentAttachments()).toHaveLength(1);

    fakeState.activeSessionId = "a";
    rerender(ui());
    await send(container);
    expect(submitAgentMessageMock.mock.calls.at(-1)?.[0]).toBe("a");
    expect(sentAttachments()).toHaveLength(0);
  });

  it("a switch to a terminal session and back keeps the image", async () => {
    const ui = () => <I18nProvider><SessionComposer /></I18nProvider>;
    const { container, rerender } = render(ui());
    await pasteImage(container);

    fakeState.activeSessionId = "t";
    rerender(ui());
    fakeState.activeSessionId = "a";
    rerender(ui());
    await send(container);
    expect(sentAttachments()).toHaveLength(1);
  });
});

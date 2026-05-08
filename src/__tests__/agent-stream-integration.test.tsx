/**
 * Phase 9 (v1.0.0 redesign) — full agent-stream integration test.
 *
 * Replays each captured Claude `--print --output-format stream-json` fixture
 * through the *full* pipeline:
 *
 *   NDJSON line → AgentEvent → reduceEvent → AgentSessionState →
 *     <MessageRow> + <ResultFooter> → DOM string
 *
 * and asserts the rendered output matches the redesign spec
 * (`docs/internal/v1-redesign-playbook.md` §5 Visual Grammar). This is the
 * end-to-end pin against accidental regressions in any individual layer:
 * reducer drift, tool-family routing breakage, colophon-format slips, or
 * caps-header reappearance.
 *
 * Rendering uses `react-dom/server`'s `renderToString` (the established Phase
 * 1 pattern); no React Testing Library, no new test deps.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// `AgentSessionView` imports `@tauri-apps/api/event` at module load — mock it
// so a Node-environment test can import the file without a Tauri runtime.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { renderToString } from "react-dom/server";
import { MessageRow } from "../agent/AgentSessionView";
import { ResultFooter } from "../agent/blocks/ResultFooter";
import { reduceAll } from "../agent/messageStore";
import type { AgentSessionState } from "../agent/messageStore";
import { formatColophon } from "../utils/formatColophon";
import type {
  AgentEvent,
  ToolUseBlockData,
} from "../agent/types";

// --- Fixture loader ---------------------------------------------------------

function loadFixture(name: string): AgentEvent[] {
  const path = join(
    __dirname,
    "../../src-tauri/test-fixtures/agent-stream",
    `${name}.ndjson`,
  );
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AgentEvent);
}

// --- Render helper ----------------------------------------------------------

/**
 * Render a complete `AgentSessionState` to a single HTML string: every
 * message row in order, followed by the colophon footer if a result event
 * was captured. This is the same shape `<AgentSessionView>` produces minus
 * the chrome (header / scroll container / stderr panel) — what we want to
 * assert against is the *content surface*.
 */
function renderState(state: AgentSessionState): string {
  return renderToString(
    <>
      {state.messages.map((msg) => (
        <MessageRow
          key={msg.id}
          message={msg}
          toolResults={state.toolResults}
          streamingMessageId={state.streamingMessageId}
          thinkingStartedAt={state.thinkingStartedAt}
          thinkingElapsed={state.thinkingElapsed}
        />
      ))}
      {state.resultEvent ? <ResultFooter result={state.resultEvent} /> : null}
    </>,
  );
}

const FIXTURES = ["text-response", "tool-bash", "thinking"] as const;

// === Group 1: state-level assertions (post-reduce) ==========================

describe("agent stream integration: text-response fixture", () => {
  const events = loadFixture("text-response");
  const state = reduceAll(events);

  it("captures the init event", () => {
    expect(state.initialized).toBe(true);
    expect(state.initEvent).not.toBeNull();
    expect(state.initEvent?.subtype).toBe("init");
    expect(typeof state.initEvent?.session_id).toBe("string");
  });

  it("ends with streamingMessageId === null (turn finished)", () => {
    expect(state.streamingMessageId).toBeNull();
  });

  it("has runningToolUseIds.size === 0 (no tools were used)", () => {
    expect(state.runningToolUseIds.size).toBe(0);
  });

  it("captures the result event", () => {
    expect(state.resultEvent).not.toBeNull();
    expect(state.resultEvent?.subtype).toBe("success");
    expect(state.resultEvent?.is_error).toBe(false);
  });

  it("has at least one assistant message", () => {
    const assistantMessages = state.messages.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
  });
});

describe("agent stream integration: tool-bash fixture", () => {
  const events = loadFixture("tool-bash");
  const state = reduceAll(events);

  it("renders a tool_use → tool_result pairing", () => {
    const allBlocks = state.messages.flatMap((m) => m.blocks);
    const toolUse = allBlocks.find((b) => b.type === "tool_use") as
      | ToolUseBlockData
      | undefined;
    expect(toolUse).toBeDefined();
    expect(toolUse!.name).toBe("Bash");
    expect(state.toolResults.has(toolUse!.id)).toBe(true);
    // Paired tool_result removes the id from the running set.
    expect(state.runningToolUseIds.has(toolUse!.id)).toBe(false);
  });

  it("ends with runningToolUseIds.size === 0 (all tools paired)", () => {
    expect(state.runningToolUseIds.size).toBe(0);
  });

  it("ends with streamingMessageId === null", () => {
    expect(state.streamingMessageId).toBeNull();
  });

  it("captures elapsed time for at least one thinking block", () => {
    expect(state.thinkingElapsed.size).toBeGreaterThan(0);
  });

  it("captures the result event", () => {
    expect(state.resultEvent).not.toBeNull();
    expect(state.resultEvent?.subtype).toBe("success");
  });
});

describe("agent stream integration: thinking fixture", () => {
  const events = loadFixture("thinking");
  const state = reduceAll(events);

  it("captures at least one thinking block elapsed time", () => {
    const allBlocks = state.messages.flatMap((m) => m.blocks);
    const thinkingBlock = allBlocks.find((b) => b.type === "thinking");
    expect(thinkingBlock).toBeDefined();
    expect(state.thinkingElapsed.size).toBeGreaterThan(0);
  });

  it("freezes thinking elapsed on result event (no pending timers)", () => {
    // After the `result` event arrives, every thinking timer is frozen and
    // moved out of the started map.
    expect(state.thinkingStartedAt.size).toBe(0);
  });

  it("ends with streamingMessageId === null", () => {
    expect(state.streamingMessageId).toBeNull();
  });
});

// === Group 2: render-level assertions (DOM string output) ===================

describe("rendered DOM matches redesign spec — text-response", () => {
  const state = reduceAll(loadFixture("text-response"));
  const html = renderState(state);

  it("does not render ASSISTANT or USER caps role headers", () => {
    expect(html).not.toMatch(/>USER</);
    expect(html).not.toMatch(/>ASSISTANT</);
    expect(html).not.toContain("agent-message-role-label");
    expect(html).not.toContain("agent-message-role");
  });

  it("renders an assistant message row with data-role=assistant + speaker chip + body", () => {
    expect(html).toContain('data-role="assistant"');
    expect(html).toContain("agent-message-speaker");
    expect(html).toContain("agent-message-avatar");
    expect(html).toContain("agent-message-assistant");
    expect(html).toContain("agent-message-body");
    // Old logbook gutter artefacts must stay gone.
    expect(html).not.toContain("agent-message-gutter");
    expect(html).not.toContain("№");
  });

  it("renders the colophon summary, not the old CAPS CI dump", () => {
    expect(html).toContain("agent-colophon");
    expect(html).toContain("agent-colophon-summary");
    expect(html).not.toContain("agent-result-footer");
    expect(html).not.toContain("agent-result-item");
  });

  it("rendered colophon text matches formatColophon output", () => {
    const expected = formatColophon({
      duration_ms: state.resultEvent?.duration_ms,
      usage: state.resultEvent?.usage as { output_tokens?: number } | undefined,
      total_cost_usd: state.resultEvent?.total_cost_usd,
    });
    expect(expected.length).toBeGreaterThan(0);
    expect(html).toContain(expected);
  });

  it("does not render old CAPS-label colophon strings", () => {
    expect(html).not.toMatch(/\bCOST \$/);
    expect(html).not.toMatch(/\bTOKENS \d+ in/);
  });
});

describe("rendered DOM matches redesign spec — tool-bash", () => {
  const state = reduceAll(loadFixture("tool-bash"));
  const html = renderState(state);

  it("dispatches the Bash tool to ExecToolBlock (not a legacy BashBlock)", () => {
    expect(html).toContain("agent-tool-exec");
    // Old monolithic-block class names that pre-dated tool families.
    expect(html).not.toContain("agent-bash-block");
    expect(html).not.toContain("agent-tool-block-bash");
  });

  it("ExecToolBlock renders with data-status=success when tool completed", () => {
    expect(html).toMatch(/data-status="success"/);
    // The fixture's tool_result is_error=false, so no error status appears.
    expect(html).not.toContain('data-status="error"');
  });

  it("renders the exec glyph (▸) for the bash command", () => {
    expect(html).toContain("▸");
  });

  it("renders the captured shell command text", () => {
    expect(html).toContain("echo hello");
  });

  it("does not dispatch to file/search/web/generic for a Bash tool", () => {
    expect(html).not.toContain("agent-tool-file");
    expect(html).not.toContain("agent-tool-search");
    expect(html).not.toContain("agent-tool-web");
    expect(html).not.toContain("agent-tool-generic");
  });

  it("renders the colophon footer (turn ended successfully)", () => {
    expect(html).toContain("agent-colophon-summary");
  });
});

describe("rendered DOM matches redesign spec — thinking", () => {
  const state = reduceAll(loadFixture("thinking"));
  const html = renderState(state);

  it("renders ThinkingBlock chrome (not a generic JSON dump)", () => {
    // `<ThinkingBlock>` uses class `agent-thinking-*`. The exact subclass set
    // is asserted by the dedicated thinking-block tests; here we just confirm
    // the family is present.
    expect(html).toMatch(/agent-thinking/);
    expect(html).not.toContain("agent-unknown-block");
  });

  it("renders an assistant message row, not a user one", () => {
    expect(html).toContain('data-role="assistant"');
    expect(html).not.toContain('data-role="user"');
  });

  it("renders the colophon at the end of the turn", () => {
    expect(html).toContain("agent-colophon-summary");
  });
});

// === Group 3: regression — old strings absent across every fixture ==========

describe("no legacy redesign strings (all fixtures)", () => {
  it("no fixture renders 'ASSISTANT' / 'USER' caps headers", () => {
    for (const name of FIXTURES) {
      const html = renderState(reduceAll(loadFixture(name)));
      // Caps role labels appearing as element text content.
      expect(html, `fixture: ${name}`).not.toMatch(/>USER</);
      expect(html, `fixture: ${name}`).not.toMatch(/>ASSISTANT</);
      // And the legacy class names that wrapped them.
      expect(html, `fixture: ${name}`).not.toContain("agent-message-role-label");
      expect(html, `fixture: ${name}`).not.toContain("agent-message-role");
    }
  });

  it("no fixture shows old CAPS result-footer labels", () => {
    for (const name of FIXTURES) {
      const html = renderState(reduceAll(loadFixture(name)));
      expect(html, `fixture: ${name}`).not.toMatch(/\bCACHE READ\b/);
      expect(html, `fixture: ${name}`).not.toMatch(/\bDURATION\b/);
      expect(html, `fixture: ${name}`).not.toMatch(/\bCOST \$/);
      expect(html, `fixture: ${name}`).not.toMatch(/\bTOKENS \d+ in/);
    }
  });

  it("no fixture renders pre-redesign tool-block class names", () => {
    for (const name of FIXTURES) {
      const html = renderState(reduceAll(loadFixture(name)));
      expect(html, `fixture: ${name}`).not.toContain("agent-bash-block");
      expect(html, `fixture: ${name}`).not.toContain("agent-tool-block-bash");
      expect(html, `fixture: ${name}`).not.toContain("agent-result-footer");
    }
  });

  it("every fixture ends in a fully-quiesced streaming state", () => {
    for (const name of FIXTURES) {
      const state = reduceAll(loadFixture(name));
      expect(state.streamingMessageId, `fixture: ${name}`).toBeNull();
      expect(state.runningToolUseIds.size, `fixture: ${name}`).toBe(0);
      expect(state.thinkingStartedAt.size, `fixture: ${name}`).toBe(0);
    }
  });
});

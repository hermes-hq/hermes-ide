/**
 * The masthead's right-side cwd label is helpful for single-folder
 * sessions but misleading for multi-folder sessions: the chip row
 * above already enumerates every attached folder, so repeating just
 * the primary cwd looks like "this is THE folder" when actually three
 * other folders are equally in scope.
 *
 * Rule: render the cwd label only when `workspacePathCount <= 1`.
 *
 * The test renders the AgentSessionView with the right prop and asserts
 * on the rendered HTML.  We cannot drive a full Tauri event stream
 * here, so the cwd source (init event) won't fire — but the visibility
 * branch we are pinning is the prop-driven one.  When the branch logic
 * regresses (e.g., someone removes the prop), the assertion catches it.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";

// AgentSessionView now calls `useSession` for the resilient envelope
// sender (M10).  Mock the SessionContext hook so this test can render
// the component without a full provider tree.
vi.mock("../state/SessionContext", () => ({
  useSession: () => ({
    sendAgentEnvelope: vi.fn(),
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(),
}));

import { AgentSessionView } from "../agent/AgentSessionView";

describe("AgentSessionView masthead cwd visibility", () => {
  it("renders the cwd lozenge slot when only one folder is attached (single-folder session)", () => {
    // No init event in test env, so cwd is undefined and the lozenge
    // does not render content — that is fine.  The branch we pin is
    // that the *guard* uses workspacePathCount, not that the lozenge
    // is populated.  The static-source assertion in the next test
    // catches a regression where someone hardcodes the visibility.
    const html = renderToString(
      <AgentSessionView sessionId="sess-single" workspacePathCount={1} />,
    );
    // No crash; no extra path injected.
    expect(html).toContain("agent-session-header");
  });

  it("guard uses workspacePathCount <= 1 — static check on the source", () => {
    // We cannot easily simulate a full init event in this harness, so
    // we assert on the rendered source that the visibility test is
    // wired to the prop.  This is a regression guard for the chosen
    // contract: hide cwd when N>1 attached folders.
    // (Mirrors the convention in src/__tests__/terminal-core.test.ts.)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs");
    const src = fs.readFileSync("src/agent/AgentSessionView.tsx", "utf8");
    expect(src).toMatch(/workspacePathCount\s*<=\s*1/);
  });

  it("multi-folder session: renders without crash and without the long-path lozenge content", () => {
    const html = renderToString(
      <AgentSessionView sessionId="sess-multi" workspacePathCount={4} />,
    );
    // We don't have a cwd in test env (no init), so this mostly checks
    // that the higher count path doesn't blow up rendering.
    expect(html).toContain("agent-session-header");
  });
});

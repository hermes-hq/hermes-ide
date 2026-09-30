// The fake agent's banner is found wherever it lands on a terminal line
// (F30 and F35 wait for it through agent-setup-steps.mjs).
import { describe, expect, it } from "vitest";
import { FAKE_AGENT_BANNER, bannerIn } from "./agent-setup-steps.mjs";

describe("the fake agent's banner", () => {
  it("at the start of a line", () => {
    const line = "FAKE-AGENT claude --permission-mode acceptEdits";
    expect(FAKE_AGENT_BANNER.test(line)).toBe(true);
    expect(bannerIn(line)).toBe(line);
  });

  it("after a wrapped prompt and the launch command (a CI runner's long host name)", () => {
    // The shape the macOS CI runner's terminal read (a synthetic host name):
    // bash redrew the wrapped command line, and the banner followed the
    // session id directly.
    const host = "ci-00000000-1111-2222-3333-444444444444-ABCDEF";
    const line = `${host}:f35-project runner$ hi ${host}:f35-project runner$ hi run 19ec8d3c-0000-4000-8000-0000000000d9FAKE-AGENT claude --session-id 08a91d43 --permission-mode acceptEdits`;
    expect(FAKE_AGENT_BANNER.test(line)).toBe(true);
    expect(bannerIn(line)).toBe("FAKE-AGENT claude --session-id 08a91d43 --permission-mode acceptEdits");
    // What F35 checks on the banner still holds.
    expect(bannerIn(line)).toMatch(/^FAKE-AGENT claude\b/);
    expect(bannerIn(line)).toMatch(/ --permission-mode acceptEdits\b/);
  });

  it("no banner", () => {
    expect(bannerIn("runner$ hi run 19ec8d3c")).toBeNull();
    expect(FAKE_AGENT_BANNER.test("fake-agent bye")).toBe(false);
  });
});

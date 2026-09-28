// N12/N13 — the frontend side of launch-and-resume: the flag exists, the
// saved workspace carries the agent's conversation id (and only a real one),
// and the session list shows the startup-prompt guess.
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "../featureFlags/registry";
import { validateSavedWorkspace } from "../types/session";
import { translate } from "../i18n/registry";

function savedSession(extra: Record<string, unknown>) {
  return {
    version: 2,
    sessions: [{ id: "s1", label: "Claude", ai_provider: "claude", project_ids: [], ...extra }],
    layout: null,
    focused_pane_id: null,
    active_session_id: "s1",
  };
}

describe("launchHelper feature flag", () => {
  it("is registered so the hidden Flags section can turn it on", () => {
    const flag = FEATURE_FLAGS.find((f) => f.id === "launchHelper");
    expect(flag).toBeDefined();
    expect(flag!.description).toMatch(/resume/i);
  });
});

describe("saved workspace: vendor_session_id", () => {
  it("keeps a conversation id so a restore can resume it", () => {
    const ws = validateSavedWorkspace(savedSession({ vendor_session_id: "11111111-2222-4333-8444-555555555555" }));
    expect(ws?.sessions[0].vendor_session_id).toBe("11111111-2222-4333-8444-555555555555");
  });

  it("drops an id that is not a non-empty string (a restore then starts fresh)", () => {
    for (const bad of ["", 42, null, { id: "x" }, ["a"]]) {
      const ws = validateSavedWorkspace(savedSession({ vendor_session_id: bad }));
      expect(ws, `value ${JSON.stringify(bad)}`).not.toBeNull();
      expect("vendor_session_id" in ws!.sessions[0]).toBe(false);
    }
  });

  it("leaves older saves without the field untouched", () => {
    const ws = validateSavedWorkspace(savedSession({}));
    expect(ws?.sessions[0].vendor_session_id).toBeUndefined();
    expect(ws?.sessions[0].mode).toBe("terminal");
  });
});

describe("startup-prompt label", () => {
  it("has an English label for the session list tag", () => {
    expect(translate("sessions.startupPrompt")).toBe("waiting at a startup prompt");
  });
});

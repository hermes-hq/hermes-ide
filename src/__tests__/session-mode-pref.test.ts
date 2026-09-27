import { describe, expect, it } from "vitest";
import {
  hasAgentView,
  parseSessionModeByProvider,
  preferredSessionMode,
  rememberSessionMode,
} from "../utils/sessionModePref";

describe("session_mode_by_provider preference", () => {
  it("only Claude has an Agent view", () => {
    expect(hasAgentView("claude")).toBe(true);
    for (const id of ["codex", "gemini", "aider", "copilot", "kiro", "", null, undefined]) {
      expect(hasAgentView(id)).toBe(false);
    }
  });

  it("parses the stored map and drops anything malformed", () => {
    expect(parseSessionModeByProvider(null)).toEqual({});
    expect(parseSessionModeByProvider("")).toEqual({});
    expect(parseSessionModeByProvider("{not json")).toEqual({});
    expect(parseSessionModeByProvider("[\"agent\"]")).toEqual({});
    expect(parseSessionModeByProvider("\"agent\"")).toEqual({});
    expect(
      parseSessionModeByProvider(JSON.stringify({ claude: "agent", codex: "terminal", gemini: "chat", aider: 3 })),
    ).toEqual({ claude: "agent", codex: "terminal" });
  });

  it("preselects terminal unless the user chose the Agent view for an agent that has one", () => {
    expect(preferredSessionMode({}, "claude")).toBe("terminal");
    expect(preferredSessionMode({ claude: "terminal" }, "claude")).toBe("terminal");
    expect(preferredSessionMode({ claude: "agent" }, "claude")).toBe("agent");
    // A stale or hand-edited "agent" for an agent without a view is ignored.
    expect(preferredSessionMode({ codex: "agent" }, "codex")).toBe("terminal");
    expect(preferredSessionMode({ claude: "agent" }, null)).toBe("terminal");
  });

  it("remembers per agent without touching the others", () => {
    const prefs = { codex: "terminal" as const };
    const next = rememberSessionMode(prefs, "claude", "agent");
    expect(next).toEqual({ codex: "terminal", claude: "agent" });
    expect(prefs).toEqual({ codex: "terminal" }); // input not mutated
    expect(rememberSessionMode(next, "claude", "terminal")).toEqual({ codex: "terminal", claude: "terminal" });
    // Agents without a view are always stored as terminal.
    expect(rememberSessionMode({}, "gemini", "agent")).toEqual({ gemini: "terminal" });
  });
});

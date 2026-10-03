/**
 * Vendor-neutral delivery of library entries: how a persona reaches each
 * agent the catalog knows (system prompt where a proven flag exists, first
 * message otherwise, the clipboard when the agent takes no first prompt),
 * the hodios target each agent maps to, and where installs go.
 */
import { describe, expect, it } from "vitest";
import { listAgents } from "../catalog/agentCatalog";
import { PERSONA_ONLY_TAIL, launchPrompts, personaDelivery, systemPromptFlag, withPersona } from "../library/delivery";
import { installTarget, invocation, targetName, worksTarget } from "../library/targets";

const persona = { id: "security-auditor", version: "1.0.0", title: "Security auditor", text: "From now on, work as this persona: Security auditor.\n\nReport exploitable issues only." };

describe("persona delivery", () => {
  it("uses a system prompt only where the catalog has a proven flag", () => {
    expect(personaDelivery("claude", "terminal")).toBe("system");
    expect(systemPromptFlag("claude")).toBe("--append-system-prompt");
    for (const id of ["codex", "gemini", "copilot", "opencode", "antigravity", "kiro"]) {
      expect(personaDelivery(id, "terminal"), id).toBe("first-message");
      expect(systemPromptFlag(id), id).toBeNull();
    }
    for (const id of ["goose", "aider", "hermes-agent", "custom"]) {
      expect(personaDelivery(id, "terminal"), id).toBe("clipboard");
    }
    // The Agent view takes it as its first message.
    expect(personaDelivery("claude", "agent")).toBe("first-message");
  });

  it("covers every agent in the catalog", () => {
    for (const a of listAgents(true)) {
      expect(["system", "first-message", "clipboard"]).toContain(personaDelivery(a.id, "terminal"));
    }
  });

  it("builds what each agent starts with", () => {
    expect(launchPrompts("claude", "terminal", "Review auth.ts", persona)).toEqual({ firstPrompt: "Review auth.ts", systemPrompt: persona.text });
    const codex = launchPrompts("codex", "terminal", "Review auth.ts", persona);
    expect(codex.systemPrompt).toBeNull();
    expect(codex.firstPrompt.startsWith(persona.text)).toBe(true);
    expect(codex.firstPrompt.endsWith("Review auth.ts")).toBe(true);
    // No persona: the task as it is.
    expect(launchPrompts("codex", "terminal", "Do it", null)).toEqual({ firstPrompt: "Do it", systemPrompt: null });
    // A persona alone: Claude just opens with it; others are told to wait.
    expect(launchPrompts("claude", "terminal", "", persona)).toEqual({ firstPrompt: "", systemPrompt: persona.text });
    expect(launchPrompts("gemini", "terminal", "", persona).firstPrompt.endsWith(PERSONA_ONLY_TAIL)).toBe(true);
    expect(withPersona("", "task")).toBe("task");
  });
});

describe("targets", () => {
  it("maps agents to the works facet", () => {
    expect(worksTarget("claude")).toBe("claude-code");
    expect(worksTarget("gemini")).toBe("gemini-cli");
    expect(worksTarget("antigravity")).toBe("antigravity");
    expect(worksTarget("goose")).toBe("agents-md");
    expect(targetName("claude-code")).toBe("Claude Code");
    expect(targetName("agents-md")).toBe("AGENTS.md");
  });

  it("installs into each agent's own files, AGENTS.md otherwise", () => {
    expect(installTarget("claude", "prompt")).toBe("claude-code");
    expect(installTarget("codex", "persona")).toBe("codex");
    expect(installTarget("antigravity", "prompt")).toBe("codex");
    expect(installTarget("antigravity", "rule")).toBe("agents-md");
    expect(installTarget("goose", "rule")).toBe("agents-md");
    expect(installTarget("goose", "prompt")).toBeNull();
    expect(installTarget("custom", "workflow")).toBeNull();
  });

  it("says how to invoke what was installed", () => {
    expect(invocation("claude", "review-pull-request", "prompt")).toBe("/review-pull-request");
    expect(invocation("codex", "review-pull-request", "prompt")).toBe("$review-pull-request");
    expect(invocation("claude", "security-auditor", "persona")).toBe("@security-auditor");
    expect(invocation("codex", "security-auditor", "persona")).toBeNull();
    expect(invocation("gemini", "strict", "rule")).toBeNull();
  });
});

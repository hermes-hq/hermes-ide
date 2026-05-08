// @vitest-environment jsdom
/**
 * M8 — Session creator Step 1 clarity.  Make the "Chat with Claude" /
 * "Terminal" / "SSH" picker communicate which is the v1.0 native mode
 * and which is the older generic mode.  Future-proofs for additional
 * native modes (Aider native, Codex native, etc.) by carrying a
 * `category` field through the data structure.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import {
  SESSION_CREATOR_MODES,
  SessionCreatorModeStep,
} from "../components/SessionCreatorModeStep";

describe("SESSION_CREATOR_MODES — shape / categorisation", () => {
  it("every mode declares a category", () => {
    expect(SESSION_CREATOR_MODES.every((m) => typeof m.category === "string")).toBe(true);
  });

  it("includes a 'native' category for Chat with Claude", () => {
    const native = SESSION_CREATOR_MODES.filter((m) => m.category === "native");
    expect(native.length).toBeGreaterThanOrEqual(1);
    const claude = native.find((m) => m.id === "agent");
    expect(claude).toBeDefined();
    expect(claude!.label.toLowerCase()).toContain("claude");
  });

  it("Terminal carries category=universal (older, any-CLI mode)", () => {
    const term = SESSION_CREATOR_MODES.find((m) => m.id === "terminal");
    expect(term?.category).toBe("universal");
  });

  it("SSH carries category=remote", () => {
    const ssh = SESSION_CREATOR_MODES.find((m) => m.id === "ssh");
    expect(ssh?.category).toBe("remote");
  });

  it("native modes carry a `badge` field — surfaced as a NEW pill", () => {
    const claude = SESSION_CREATOR_MODES.find((m) => m.id === "agent");
    expect(claude?.badge).toBe("NEW");
  });

  it("universal mode does NOT carry a NEW badge", () => {
    const term = SESSION_CREATOR_MODES.find((m) => m.id === "terminal");
    expect(term?.badge).toBeUndefined();
  });

  it("structure permits future natives — extending the array doesn't break the shape", () => {
    // Defensive: every entry has the required keys.  Future entries
    // (e.g., Aider native, Codex native) add to the array; the
    // renderer must not break.
    for (const m of SESSION_CREATOR_MODES) {
      expect(typeof m.id).toBe("string");
      expect(typeof m.label).toBe("string");
      expect(typeof m.description).toBe("string");
      expect(typeof m.category).toBe("string");
    }
  });
});

describe("SessionCreatorModeStep — render", () => {
  afterEach(() => cleanup());

  it("renders the NATIVE section header above Claude", () => {
    render(<SessionCreatorModeStep selected="agent" onSelect={() => {}} />);
    expect(screen.getByText(/^NATIVE$/i)).toBeInTheDocument();
  });

  it("renders the UNIVERSAL section header above Terminal", () => {
    render(<SessionCreatorModeStep selected="agent" onSelect={() => {}} />);
    expect(screen.getByText(/^UNIVERSAL$/i)).toBeInTheDocument();
  });

  it("renders the NEW badge on Chat with Claude", () => {
    render(<SessionCreatorModeStep selected="agent" onSelect={() => {}} />);
    const badges = document.querySelectorAll(".session-creator-mode-badge");
    expect(badges.length).toBeGreaterThanOrEqual(1);
    const newBadge = Array.from(badges).find((b) => b.textContent === "NEW");
    expect(newBadge).toBeTruthy();
  });

  it("Terminal description mentions 'older' or 'generic' framing for clarity", () => {
    render(<SessionCreatorModeStep selected="agent" onSelect={() => {}} />);
    const term = screen.getByText(/Chat with Claude/i).closest(".session-creator-mode-step");
    // Find the terminal card — its description must mention the universal framing.
    const cards = document.querySelectorAll(".session-creator-mode-card");
    const termCard = Array.from(cards).find((c) => c.textContent?.toLowerCase().includes("terminal"));
    expect(termCard?.textContent?.toLowerCase()).toMatch(/universal|generic|any cli|other tools|0\.6/);
    expect(term).not.toBeNull();
  });

  it("groups order: native first → universal → remote (locked rendering)", () => {
    render(<SessionCreatorModeStep selected="agent" onSelect={() => {}} />);
    const headers = Array.from(document.querySelectorAll(".session-creator-mode-group-label"))
      .map((h) => h.textContent?.trim().toUpperCase());
    expect(headers).toEqual(["NATIVE", "UNIVERSAL", "REMOTE"]);
  });
});

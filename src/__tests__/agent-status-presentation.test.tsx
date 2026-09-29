/**
 * F10 — every status has a glyph and a word; nothing is conveyed by colour
 * alone; a guessed status is dimmed and says "guessed".
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/settings", () => ({
  setSetting: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  getSettings: vi.fn(async () => ({})),
}));

import { renderToString } from "react-dom/server";
import { AGENT_STATUS_KINDS, type AgentStatusKind } from "../agent/contract/status";
import {
  GUESSED_WORD_KEY,
  STATUS_GLYPHS,
  STATUS_MESSAGE_KEYS,
  STATUS_TONES,
  reporterOfSource,
  statusLabel,
  statusWordKey,
} from "../agent/status/presentation";
import { getI18nSnapshot, translate, translateIn } from "../i18n/registry";
import { loadAllLanguagePacks } from "../i18n/packs";
import { I18nProvider } from "../i18n/I18nProvider";
import { AgentStatusTag } from "../components/AgentStatusTag";
import { _resetSessionEventStoreForTest, dispatchSessionEvent } from "../agent/contract/sessionEventStore";
import { _resetAttentionStoreForTest } from "../agent/status/attentionStore";

const packs = await loadAllLanguagePacks();
const english = getI18nSnapshot().languages.find((l) => l.locale === "en")!;

afterEach(() => {
  _resetSessionEventStoreForTest();
  _resetAttentionStoreForTest();
});

describe("glyphs", () => {
  it("every kind has a non-empty glyph, and no two kinds share one", () => {
    const glyphs = AGENT_STATUS_KINDS.map((k) => STATUS_GLYPHS[k]);
    expect(glyphs.every((g) => typeof g === "string" && g.trim().length > 0)).toBe(true);
    expect(new Set(glyphs).size).toBe(AGENT_STATUS_KINDS.length);
  });

  it("no glyph is an emoji (they render as pictures, not text)", () => {
    for (const g of Object.values(STATUS_GLYPHS)) expect(/\p{Extended_Pictographic}/u.test(g)).toBe(false);
  });

  it("every kind has a tone", () => {
    for (const k of AGENT_STATUS_KINDS) expect(["attention", "ready", "active", "quiet"]).toContain(STATUS_TONES[k]);
  });
});

describe("words", () => {
  it("English has a distinct word for every kind", () => {
    const words = AGENT_STATUS_KINDS.map((k) => english.messages[statusWordKey(k)]);
    expect(words.every((w) => typeof w === "string" && w.trim().length > 0)).toBe(true);
    expect(new Set(words).size).toBe(AGENT_STATUS_KINDS.length);
  });

  it.each(packs.map((p) => [p.locale, p] as const))("%s translates every status key", (_locale, pack) => {
    for (const key of STATUS_MESSAGE_KEYS) {
      const v = pack.messages[key];
      expect(typeof v === "string" && v.trim().length > 0, `${pack.locale} ${key}`).toBe(true);
    }
    const words = AGENT_STATUS_KINDS.map((k) => translateIn(pack, statusWordKey(k)));
    expect(new Set(words).size).toBe(AGENT_STATUS_KINDS.length);
  });
});

describe("statusLabel", () => {
  it("a guessed status carries the word guessed; a sure one does not", () => {
    expect(statusLabel({ kind: "working", confidence: "guessed", detail: "" }, translate).guessed).toBe(english.messages[GUESSED_WORD_KEY]);
    expect(statusLabel({ kind: "working", confidence: "exact", detail: "" }, translate).guessed).toBeNull();
    expect(statusLabel({ kind: "working", confidence: "signal", detail: "" }, translate).guessed).toBeNull();
  });

  it("puts the detail line first in the tooltip, then how sure Hermes is", () => {
    const l = statusLabel({ kind: "needs_approval", confidence: "exact", detail: "Bash: rm -rf build" }, translate);
    expect(l).toMatchObject({ glyph: "!", word: "needs approval", tone: "attention" });
    expect(l.title).toBe("Bash: rm -rf build\nReported by the agent itself");
  });

  it("words an exit from its code or signal", () => {
    expect(statusLabel({ kind: "exited", confidence: "exact", detail: "", exit: { code: 3, signal: null } }, translate).title).toMatch(/^exit code 3\n/);
    expect(statusLabel({ kind: "exited", confidence: "exact", detail: "", exit: { code: null, signal: "SIGTERM" } }, translate).title).toMatch(/^signal SIGTERM\n/);
  });
});

describe("<AgentStatusTag>", () => {
  const render = (id: string) =>
    renderToString(
      <I18nProvider>
        <AgentStatusTag sessionId={id} />
      </I18nProvider>,
    );

  it.each(AGENT_STATUS_KINDS.map((k) => [k]))("renders glyph and word for %s", (kind: AgentStatusKind) => {
    dispatchSessionEvent("s1", { type: "status", at: 1, source: "hook:x", status: { kind, confidence: "exact", detail: "d" } });
    const html = render("s1");
    expect(html).toContain(`data-status="${kind}"`);
    expect(html).toContain(`<span class="agent-status-glyph" aria-hidden="true">${STATUS_GLYPHS[kind]}</span>`);
    expect(html).toContain(`<span class="agent-status-word">${english.messages[statusWordKey(kind)]}</span>`);
    expect(html).not.toContain("agent-status-guessed");
  });

  it("marks a guess in words and with data-confidence (the CSS dims it)", () => {
    dispatchSessionEvent("s2", { type: "status", at: 1, source: "pty", status: { kind: "working", confidence: "guessed", detail: "" } });
    const html = render("s2");
    expect(html).toContain('data-confidence="guessed"');
    expect(html).toContain(`<span class="agent-status-guessed">guessed</span>`);
  });

  it("a session nothing reported on reads idle, guessed", () => {
    const html = render("nobody");
    expect(html).toContain('data-status="idle"');
    expect(html).toContain("guessed");
  });

  it("says 'exact' next to what an agent reported, and names the agent in the tooltip", () => {
    dispatchSessionEvent("s3", { type: "status", at: 1, source: "hook:claude", status: { kind: "needs_approval", confidence: "exact", detail: "Bash" } });
    const html = render("s3");
    expect(html).toContain('<span class="agent-status-sure">exact</span>');
    expect(html).toContain('data-source="hook:claude"');
    expect(html).toContain("Reported by Claude Code itself");
    expect(html).not.toContain("agent-status-guessed");
  });

  it("a notification says 'signal'; a process fact is a guess from the processes", () => {
    dispatchSessionEvent("s4", { type: "status", at: 1, source: "osc", status: { kind: "needs_approval", confidence: "signal", detail: "" } });
    expect(render("s4")).toContain('<span class="agent-status-sure">signal</span>');
    dispatchSessionEvent("s5", { type: "status", at: 1, source: "os", status: { kind: "working", confidence: "guessed", detail: "a command is running (zsh)" } });
    const html = render("s5");
    expect(html).toContain(`<span class="agent-status-guessed">guessed</span>`);
    expect(html).not.toContain("agent-status-sure");
    expect(html).toContain("Guessed from the agent&#x27;s processes");
  });
});

describe("reporterOfSource", () => {
  it("names the agent of a hook, stream or protocol source, and nobody for Hermes's own", () => {
    expect(reporterOfSource("hook:claude")).toBe("claude");
    expect(reporterOfSource("hook:claude:osc")).toBe("claude");
    expect(reporterOfSource("stream:opencode")).toBe("opencode");
    expect(reporterOfSource("protocol:codex")).toBe("codex");
    for (const s of ["osc", "os", "pty", "hi", "e2e", "hook", null, undefined]) expect(reporterOfSource(s)).toBeNull();
  });
  it("statusLabel names the reporter, or says a process guess is one", () => {
    expect(statusLabel({ kind: "working", confidence: "exact", detail: "", agentName: "Codex" }, translate).title).toBe("Reported by Codex itself");
    expect(statusLabel({ kind: "working", confidence: "exact", detail: "" }, translate).title).toBe("Reported by the agent itself");
    expect(statusLabel({ kind: "working", confidence: "guessed", detail: "", source: "os" }, translate).title).toMatch(/processes/);
    expect(statusLabel({ kind: "working", confidence: "exact", detail: "" }, translate).sure).toBe("exact");
    expect(statusLabel({ kind: "working", confidence: "guessed", detail: "" }, translate).sure).toBeNull();
  });
});

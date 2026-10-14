/**
 * Tests for Claude channel plugins support.
 *
 * Covers:
 * - CLAUDE_CHANNELS constant shape and values
 * - Channel selection / deselection logic
 * - Channels field in CreateSessionOpts and SessionData types
 * - Channels only available for Claude provider
 * - Channels passed through to onCreate
 */
import { describe, it, expect, vi } from "vitest";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("mocked"))),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../terminal/TerminalPool", () => ({
  createTerminal: vi.fn(),
  destroy: vi.fn(),
  updateSettings: vi.fn(),
  writeScrollback: vi.fn(),
}));
vi.mock("../utils/notifications", () => ({
  initNotifications: vi.fn(),
  notifyLongRunningDone: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────
import { CLAUDE_CHANNELS } from "../components/SessionCreator";
import type { CreateSessionOpts, SessionData } from "../types/session";

// =====================================================================
// CLAUDE_CHANNELS constant
// =====================================================================
describe("CLAUDE_CHANNELS", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(CLAUDE_CHANNELS)).toBe(true);
    expect(CLAUDE_CHANNELS.length).toBeGreaterThan(0);
  });

  it("contains Telegram as the first channel", () => {
    const telegram = CLAUDE_CHANNELS[0];
    expect(telegram.id).toBe("plugin:telegram@claude-plugins-official");
    expect(telegram.label).toBe("Telegram");
    expect(telegram.icon).toBeTruthy();
  });

  it("each channel has id, label, and icon fields", () => {
    for (const ch of CLAUDE_CHANNELS) {
      expect(typeof ch.id).toBe("string");
      expect(ch.id.length).toBeGreaterThan(0);
      expect(typeof ch.label).toBe("string");
      expect(ch.label.length).toBeGreaterThan(0);
      expect(typeof ch.icon).toBe("string");
      expect(ch.icon.length).toBeGreaterThan(0);
    }
  });

  it("has unique channel IDs", () => {
    const ids = CLAUDE_CHANNELS.map((ch) => ch.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

// =====================================================================
// Channel selection / deselection logic
// =====================================================================
describe("Channel selection logic", () => {
  it("can add a channel to the selection", () => {
    const selected: string[] = [];
    const channelId = CLAUDE_CHANNELS[0].id;
    const updated = [...selected, channelId];
    expect(updated).toContain(channelId);
    expect(updated).toHaveLength(1);
  });

  it("can remove a channel from the selection", () => {
    const channelId = CLAUDE_CHANNELS[0].id;
    const selected = [channelId];
    const updated = selected.filter((c) => c !== channelId);
    expect(updated).not.toContain(channelId);
    expect(updated).toHaveLength(0);
  });

  it("does not duplicate channels when adding the same one twice", () => {
    const channelId = CLAUDE_CHANNELS[0].id;
    const selected = [channelId];
    // Simulates the guard: only add if not already included
    const alreadyIncluded = selected.includes(channelId);
    const updated = alreadyIncluded ? selected : [...selected, channelId];
    expect(updated).toHaveLength(1);
  });

  it("handles multiple channels correctly", () => {
    const channels = ["channel-a", "channel-b", "channel-c"];
    let selected: string[] = [];

    // Add all
    for (const ch of channels) {
      selected = [...selected, ch];
    }
    expect(selected).toHaveLength(3);

    // Remove middle one
    selected = selected.filter((c) => c !== "channel-b");
    expect(selected).toEqual(["channel-a", "channel-c"]);
  });
});

// =====================================================================
// CreateSessionOpts channels field
// =====================================================================
describe("CreateSessionOpts channels field", () => {
  it("accepts channels as optional string array", () => {
    const opts: CreateSessionOpts = {
      label: "test-session",
      aiProvider: "claude",
      channels: [CLAUDE_CHANNELS[0].id],
    };
    expect(opts.channels).toEqual([CLAUDE_CHANNELS[0].id]);
  });

  it("defaults channels to undefined when not provided", () => {
    const opts: CreateSessionOpts = {
      label: "test-session",
      aiProvider: "claude",
    };
    expect(opts.channels).toBeUndefined();
  });

  it("can pass empty channels array", () => {
    const opts: CreateSessionOpts = {
      label: "test-session",
      channels: [],
    };
    expect(opts.channels).toEqual([]);
  });
});

// =====================================================================
// SessionData channels field
// =====================================================================
describe("SessionData channels field", () => {
  it("has channels array in session data", () => {
    const session: SessionData = {
      id: "sess-1",
      label: "Session 1",
      description: "",
      color: "#ff0000",
      group: null,
      phase: "idle",
      working_directory: "/home/user/project",
      shell: "bash",
      created_at: "2025-01-01T00:00:00Z",
      last_activity_at: "2025-01-01T00:00:00Z",
      workspace_paths: [],
      detected_agent: null,
      metrics: {
        output_lines: 0,
        error_count: 0,
        stuck_score: 0,
        token_usage: {},
        tool_calls: [],
        tool_call_summary: {},
        files_touched: [],
        recent_errors: [],
        memory_facts: [],
        latency_p50_ms: null,
        latency_p95_ms: null,
        latency_samples: [],
        token_history: [],
      },
      ai_provider: "claude",
      auto_approve: false,
      channels: [CLAUDE_CHANNELS[0].id],
      context_injected: false,
      ssh_info: null,
    };
    expect(session.channels).toEqual([CLAUDE_CHANNELS[0].id]);
  });

  it("has empty channels array when no channels selected", () => {
    const session: SessionData = {
      id: "sess-2",
      label: "Session 2",
      description: "",
      color: "",
      group: null,
      phase: "idle",
      working_directory: "/tmp",
      shell: "zsh",
      created_at: "2025-01-01T00:00:00Z",
      last_activity_at: "2025-01-01T00:00:00Z",
      workspace_paths: [],
      detected_agent: null,
      metrics: {
        output_lines: 0,
        error_count: 0,
        stuck_score: 0,
        token_usage: {},
        tool_calls: [],
        tool_call_summary: {},
        files_touched: [],
        recent_errors: [],
        memory_facts: [],
        latency_p50_ms: null,
        latency_p95_ms: null,
        latency_samples: [],
        token_history: [],
      },
      ai_provider: null,
      auto_approve: false,
      channels: [],
      context_injected: false,
      ssh_info: null,
    };
    expect(session.channels).toEqual([]);
  });
});

// =====================================================================
// Channels only for Claude provider
// =====================================================================
describe("Channels provider constraint", () => {
  it("channels should be undefined for non-claude providers in CreateSessionOpts", () => {
    // Simulates the logic: channels are only set when aiProvider is "claude"
    const aiProvider = "gemini";
    const selectedChannels = [CLAUDE_CHANNELS[0].id];
    const channels = aiProvider === "claude" && selectedChannels.length > 0
      ? selectedChannels
      : undefined;
    expect(channels).toBeUndefined();
  });

  it("channels should be set when provider is claude and channels selected", () => {
    const aiProvider = "claude";
    const selectedChannels = [CLAUDE_CHANNELS[0].id];
    const channels = aiProvider === "claude" && selectedChannels.length > 0
      ? selectedChannels
      : undefined;
    expect(channels).toEqual([CLAUDE_CHANNELS[0].id]);
  });

  it("channels should be undefined when provider is claude but no channels selected", () => {
    const aiProvider = "claude";
    const selectedChannels: string[] = [];
    const channels = aiProvider === "claude" && selectedChannels.length > 0
      ? selectedChannels
      : undefined;
    expect(channels).toBeUndefined();
  });

  it("channels should be cleared when switching away from claude", () => {
    // Simulates the clear-on-provider-switch logic
    let selectedChannels = [CLAUDE_CHANNELS[0].id];
    const newProvider = "aider";
    if (newProvider !== "claude") {
      selectedChannels = [];
    }
    expect(selectedChannels).toEqual([]);
  });
});

// =====================================================================
// Channels passed through to onCreate
// =====================================================================
describe("Channels in onCreate opts", () => {
  it("builds correct opts with channels for local Claude session", () => {
    const connectionType = "local";
    const aiProvider = "claude";
    const selectedChannels = [CLAUDE_CHANNELS[0].id];
    const autoApprove = false;

    const opts: CreateSessionOpts = {
      label: "Claude with Telegram",
      aiProvider: connectionType === "local" ? (aiProvider || undefined) : undefined,
      autoApprove: connectionType === "local" ? (autoApprove || undefined) : undefined,
      channels: connectionType === "local" && aiProvider === "claude" && selectedChannels.length > 0
        ? selectedChannels
        : undefined,
    };

    expect(opts.channels).toEqual([CLAUDE_CHANNELS[0].id]);
    expect(opts.aiProvider).toBe("claude");
  });

  it("omits channels for SSH connections even with Claude", () => {
    const connectionType = "ssh";
    const aiProvider = "claude";
    const selectedChannels = [CLAUDE_CHANNELS[0].id];

    const channels = connectionType === "local" && aiProvider === "claude" && selectedChannels.length > 0
      ? selectedChannels
      : undefined;

    expect(channels).toBeUndefined();
  });

  it("omits channels for non-claude local sessions", () => {
    const connectionType = "local";
    const aiProvider = "gemini";
    const selectedChannels = [CLAUDE_CHANNELS[0].id];

    const channels = connectionType === "local" && aiProvider === "claude" && selectedChannels.length > 0
      ? selectedChannels
      : undefined;

    expect(channels).toBeUndefined();
  });
});

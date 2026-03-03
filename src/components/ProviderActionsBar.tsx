import "../styles/components/ProviderActionsBar.css";
import { useMemo, useState, useRef, useCallback } from "react";
import { ActionTemplate, ActionEvent } from "../state/SessionContext";
import { sendShortcutCommand } from "../terminal/TerminalPool";
import { useSession } from "../state/SessionContext";
import { CommandsPopover } from "./CommandsPopover";

// Default actions per AI provider — shown immediately before agent detection
const DEFAULT_ACTIONS: Record<string, ActionTemplate[]> = {
  claude: [
    { command: "/compact", label: "Compact", description: "Compress context window", category: "Context" },
    { command: "/clear", label: "Clear", description: "Clear conversation history", category: "Context" },
    { command: "/memory", label: "Memory", description: "View/edit project memory", category: "Context" },
    { command: "/cost", label: "Cost", description: "Show token cost breakdown", category: "Info" },
    { command: "/help", label: "Help", description: "Show available commands", category: "Info" },
    { command: "/review", label: "Review", description: "Review recent changes", category: "Code" },
    { command: "/config", label: "Config", description: "Open configuration", category: "Setup" },
    { command: "/init", label: "Init CLAUDE.md", description: "Create project memory file", category: "Setup" },
    { command: "/vim", label: "Vim Mode", description: "Toggle vim keybindings", category: "Setup" },
    { command: "/allowed-tools", label: "Allowed Tools", description: "Manage tool permissions", category: "Setup" },
    { command: "/permissions", label: "Permissions", description: "View/edit permissions", category: "Setup" },
    { command: "/doctor", label: "Doctor", description: "Check installation health", category: "Info" },
    { command: "/bug", label: "Bug Report", description: "Report a bug", category: "Info" },
    { command: "/login", label: "Login", description: "Authenticate with Anthropic", category: "Setup" },
    { command: "/logout", label: "Logout", description: "Sign out of Anthropic", category: "Setup" },
    { command: "/terminal-setup", label: "Terminal Setup", description: "Configure terminal integration", category: "Setup" },
  ],
  gemini: [
    { command: "/help", label: "Help", description: "Show available commands", category: "Info" },
    { command: "/clear", label: "Clear", description: "Clear conversation", category: "Context" },
    { command: "/stats", label: "Stats", description: "Show usage statistics", category: "Info" },
    { command: "/tools", label: "Tools", description: "List available tools", category: "Info" },
    { command: "/shell", label: "Shell", description: "Run shell command", category: "Code" },
    { command: "/edit", label: "Edit", description: "Edit a file", category: "Code" },
    { command: "/diff", label: "Diff", description: "Show file changes", category: "Code" },
    { command: "/save", label: "Save", description: "Save conversation", category: "Context" },
    { command: "/restore", label: "Restore", description: "Restore saved conversation", category: "Context" },
    { command: "/sandbox", label: "Sandbox", description: "Toggle sandbox mode", category: "Setup" },
    { command: "/yolo", label: "YOLO Mode", description: "Auto-approve all actions", category: "Setup" },
  ],
  aider: [
    { command: "/add", label: "Add File", description: "Add file to chat context", category: "Files" },
    { command: "/drop", label: "Drop File", description: "Remove file from chat context", category: "Files" },
    { command: "/ls", label: "List Files", description: "List files in chat", category: "Files" },
    { command: "/read-only", label: "Read-Only", description: "Add file as read-only", category: "Files" },
    { command: "/run", label: "Run Command", description: "Run a shell command", category: "Code" },
    { command: "/test", label: "Run Tests", description: "Run test suite", category: "Code" },
    { command: "/lint", label: "Lint", description: "Lint and fix files", category: "Code" },
    { command: "/diff", label: "Diff", description: "Show pending changes diff", category: "Git" },
    { command: "/commit", label: "Commit", description: "Commit pending changes", category: "Git" },
    { command: "/undo", label: "Undo", description: "Undo last AI change", category: "Git" },
    { command: "/git", label: "Git", description: "Run git command", category: "Git" },
    { command: "/clear", label: "Clear", description: "Clear chat history", category: "Context" },
    { command: "/map", label: "Repo Map", description: "Show repository map", category: "Context" },
    { command: "/web", label: "Web Search", description: "Search the web", category: "Context" },
    { command: "/tokens", label: "Tokens", description: "Show token usage report", category: "Info" },
    { command: "/help", label: "Help", description: "Ask questions about aider", category: "Info" },
    { command: "/model", label: "Switch Model", description: "Change AI model", category: "Setup" },
    { command: "/settings", label: "Settings", description: "Show current settings", category: "Setup" },
    { command: "/architect", label: "Architect", description: "Switch to architect mode", category: "Setup" },
    { command: "/ask", label: "Ask", description: "Switch to ask mode", category: "Setup" },
    { command: "/code", label: "Code", description: "Switch to code mode", category: "Setup" },
    { command: "/voice", label: "Voice", description: "Record and transcribe voice input", category: "Setup" },
  ],
  codex: [
    { command: "/diff", label: "Diff", description: "Show git diff including untracked files", category: "Code" },
    { command: "/review", label: "Review", description: "Review current changes and find issues", category: "Code" },
    { command: "/copy", label: "Copy", description: "Copy latest output to clipboard", category: "Code" },
    { command: "/mention", label: "Mention", description: "Mention a file", category: "Code" },
    { command: "/compact", label: "Compact", description: "Summarize conversation to save context", category: "Context" },
    { command: "/clear", label: "Clear", description: "Clear terminal and start new chat", category: "Context" },
    { command: "/plan", label: "Plan", description: "Switch to plan mode", category: "Context" },
    { command: "/status", label: "Status", description: "Show session config and token usage", category: "Info" },
    { command: "/mcp", label: "MCP", description: "List configured MCP tools", category: "Info" },
    { command: "/model", label: "Model", description: "Choose model and reasoning effort", category: "Setup" },
    { command: "/approvals", label: "Approvals", description: "Choose what Codex is allowed to do", category: "Setup" },
    { command: "/init", label: "Init AGENTS.md", description: "Create instructions file for Codex", category: "Setup" },
    { command: "/skills", label: "Skills", description: "Improve how Codex performs tasks", category: "Setup" },
    { command: "/theme", label: "Theme", description: "Choose syntax highlighting theme", category: "Setup" },
    { command: "/logout", label: "Logout", description: "Log out of Codex", category: "Setup" },
  ],
  copilot: [
    { command: "gh copilot suggest", label: "Suggest", description: "Get command suggestions", category: "AI" },
    { command: "gh copilot explain", label: "Explain", description: "Explain a command", category: "AI" },
  ],
};

// Curated pinned defaults per provider (top commands for quick access)
const PINNED_DEFAULTS: Record<string, string[]> = {
  claude: ["/compact", "/clear", "/cost", "/review", "/help"],
  gemini: ["/clear", "/help", "/stats", "/tools"],
  aider: ["/add", "/run", "/test", "/commit", "/undo"],
  codex: ["/compact", "/clear", "/diff", "/review", "/status"],
  copilot: ["gh copilot suggest", "gh copilot explain"],
};

const MAX_QUICK_ACTIONS = 5;
const DROPDOWN_THRESHOLD = 5;

interface ProviderActionsBarProps {
  sessionId: string;
  agentName: string;
  actions: ActionTemplate[];
  recentActions: ActionEvent[];
  phase: string;
  aiProvider: string | null;
}

export function ProviderActionsBar({ sessionId, actions, recentActions, aiProvider }: ProviderActionsBarProps) {
  const { dispatch } = useSession();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Use detected actions if available, otherwise fall back to defaults for the provider
  const effectiveActions = useMemo(() => {
    if (actions.length > 0) return actions;
    if (aiProvider && DEFAULT_ACTIONS[aiProvider]) return DEFAULT_ACTIONS[aiProvider];
    return [];
  }, [actions, aiProvider]);

  // Compute quick actions: up to 3 recent, then fill from pinned defaults
  const quickActions = useMemo(() => {
    const pinned = (aiProvider && PINNED_DEFAULTS[aiProvider]) || [];
    const commandSet = new Set(effectiveActions.map((a) => a.command));
    const result: ActionTemplate[] = [];
    const seen = new Set<string>();

    // Up to 3 recently used commands
    for (const event of recentActions) {
      if (result.length >= 3) break;
      if (!seen.has(event.command) && commandSet.has(event.command)) {
        const tmpl = effectiveActions.find((a) => a.command === event.command);
        if (tmpl) {
          result.push(tmpl);
          seen.add(event.command);
        }
      }
    }

    // Fill remaining from pinned defaults
    for (const cmd of pinned) {
      if (result.length >= MAX_QUICK_ACTIONS) break;
      if (!seen.has(cmd) && commandSet.has(cmd)) {
        const tmpl = effectiveActions.find((a) => a.command === cmd);
        if (tmpl) {
          result.push(tmpl);
          seen.add(cmd);
        }
      }
    }

    return result;
  }, [effectiveActions, recentActions, aiProvider]);

  const handleExecute = useCallback(
    (command: string) => {
      sendShortcutCommand(sessionId, command);
    },
    [sessionId],
  );

  const handleOpenComposer = useCallback(() => {
    dispatch({ type: "OPEN_COMPOSER" });
  }, [dispatch]);

  const showDropdown = effectiveActions.length > DROPDOWN_THRESHOLD;

  if (effectiveActions.length === 0) return null;

  return (
    <div className="provider-actions-bar">
      {/* Compose button */}
      <button
        className="pab-compose-btn"
        title="Open Prompt Composer"
        onClick={handleOpenComposer}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
        Compose
      </button>

      <div className="pab-divider" />

      {/* Quick action pills */}
      {quickActions.map((action) => (
        <button
          key={action.command}
          className="pab-action"
          title={action.description}
          onClick={() => handleExecute(action.command)}
        >
          {action.command}
        </button>
      ))}

      {/* Spacer pushes dropdown trigger to the right */}
      {showDropdown && <div className="pab-spacer" />}

      {/* Commands dropdown trigger */}
      {showDropdown && (
        <button
          ref={triggerRef}
          className={`pab-commands-trigger ${popoverOpen ? "pab-commands-trigger-active" : ""}`}
          onClick={() => setPopoverOpen((v) => !v)}
        >
          Commands
          <span className="pab-commands-count">{effectiveActions.length}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <path d="M2 4l3 3 3-3" />
          </svg>
        </button>
      )}

      {/* Commands popover */}
      {popoverOpen && triggerRef.current && (
        <CommandsPopover
          actions={effectiveActions}
          recentActions={recentActions}
          onExecute={handleExecute}
          onClose={() => setPopoverOpen(false)}
          anchorRect={triggerRef.current.getBoundingClientRect()}
        />
      )}
    </div>
  );
}

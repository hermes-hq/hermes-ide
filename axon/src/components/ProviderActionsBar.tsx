import { useMemo } from "react";
import { ActionTemplate, ActionEvent } from "../state/SessionContext";
import { utf8ToBase64 } from "../utils/encoding";
import { writeToSession } from "../api/sessions";

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
};

interface ProviderActionsBarProps {
  sessionId: string;
  agentName: string;
  actions: ActionTemplate[];
  recentActions: ActionEvent[];
  phase: string;
  aiProvider: string | null;
}

function sendCommand(sessionId: string, command: string) {
  const data = utf8ToBase64(command + "\r");
  writeToSession(sessionId, data).catch(console.error);
}

export function ProviderActionsBar({ sessionId, actions, recentActions, aiProvider }: ProviderActionsBarProps) {
  const recentCmds = useMemo(
    () => new Set(recentActions.map((a) => a.command)),
    [recentActions]
  );

  // Use detected actions if available, otherwise fall back to defaults for the provider
  const effectiveActions = useMemo(() => {
    if (actions.length > 0) return actions;
    if (aiProvider && DEFAULT_ACTIONS[aiProvider]) return DEFAULT_ACTIONS[aiProvider];
    return [];
  }, [actions, aiProvider]);

  const grouped = useMemo(() => {
    const map = new Map<string, ActionTemplate[]>();
    for (const action of effectiveActions) {
      const list = map.get(action.category) || [];
      list.push(action);
      map.set(action.category, list);
    }
    return map;
  }, [effectiveActions]);

  if (effectiveActions.length === 0) return null;

  return (
    <div className="provider-actions-bar">
      {Array.from(grouped.entries()).map(([, categoryActions]) =>
        categoryActions.map((action) => (
          <button
            key={action.command}
            className={`provider-action-btn ${recentCmds.has(action.command) ? "provider-action-btn-recent" : ""}`}
            title={action.description}
            onClick={() => sendCommand(sessionId, action.command)}
          >
            {action.label}
          </button>
        ))
      )}
    </div>
  );
}

/**
 * MCP server helpers.  Spec: docs/internal/v1-tui-parity-plan.md §2 (M3) + §7.7.
 *
 * MCP server configuration lives in `~/.claude.json` under the
 * `mcpServers` key.  Hermes writes there directly so changes apply in
 * standalone Claude Code too (locked decision §0.2 — TUI-compatible).
 */

export interface McpServerSummary {
  name: string;
  status: string;
}

/** Mirrors `claude_config::McpServerSpecView` (Rust).  Returned by the
 *  `read_mcp_server_spec` IPC.  Env / header VALUES are NEVER included
 *  — the keys are surfaced so the user knows what the server expects,
 *  but the values are stripped because they may carry tokens. */
export interface McpServerSpecView {
  name: string;
  /** "stdio" | "sse" | "http" | "unknown". */
  transport: string;
  command: string;
  args: string[];
  url: string;
  /** Names of env vars defined on the spec — values redacted. */
  env_keys: string[];
  /** Names of HTTP headers (sse/http only) — values redacted. */
  header_keys: string[];
}

/** Map an SDK status string into a stable category the UI can switch
 *  on for color + label.  The SDK reports values like "connected" /
 *  "failed" / "needs_auth" / "unknown"; we normalize so a future SDK
 *  rename doesn't quietly break the legend. */
export type McpStatusKind = "connected" | "failed" | "needs-auth" | "unknown";

export function classifyMcpStatus(raw: string | undefined | null): McpStatusKind {
  if (!raw) return "unknown";
  const s = raw.toLowerCase();
  if (s === "connected" || s === "ok" || s === "ready") return "connected";
  if (
    s === "needs_auth"
    || s === "needs-auth"
    || s === "auth_required"
    || s === "requires_auth"
  ) return "needs-auth";
  if (s === "failed" || s === "error" || s === "disconnected") return "failed";
  return "unknown";
}

export function describeMcpStatus(kind: McpStatusKind): { label: string; tone: string } {
  switch (kind) {
    case "connected":
      return {
        label: "Connected — server is responding to tool calls.",
        tone: "good",
      };
    case "needs-auth":
      return {
        label: "Needs authentication — the server is reachable but rejected the connection. Check the env vars / API key.",
        tone: "warn",
      };
    case "failed":
      return {
        label: "Failed to connect — the bridge couldn't reach this server. Check the command / URL and inspect stderr.",
        tone: "bad",
      };
    case "unknown":
    default:
      return {
        label: "Unknown — status hasn't been reported yet (live init pending) or the SDK didn't include it.",
        tone: "muted",
      };
  }
}

export interface McpStdioSpec {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpRemoteSpec {
  type: "sse" | "http";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerSpec = McpStdioSpec | McpRemoteSpec;

export interface AddMcpForm {
  name: string;
  transport: "stdio" | "sse" | "http";
  command: string;
  args: string;
  url: string;
  headers: string;
  env: Array<{ key: string; value: string }>;
}

/** Filter the init.tools list down to the MCP tools owned by `serverName`,
 *  with the `mcp__<server>__` prefix stripped for display. */
export function filterToolsForServer(tools: readonly string[], serverName: string): string[] {
  const prefix = `mcp__${serverName}__`;
  return tools
    .filter((t) => t.startsWith(prefix))
    .map((t) => t.slice(prefix.length));
}

// Mirrors the Rust validator: alphanumeric, underscore, hyphen, space,
// dot, colon.  Real MCP names from Claude's ecosystem use dots and
// colons (e.g. "claude.ai Gmail", "plugin:telegram:telegram").
const NAME_PATTERN = /^[A-Za-z0-9_\- .:]+$/;

export function validateAddMcpForm(form: AddMcpForm, existingNames: readonly string[]): string[] {
  const errors: string[] = [];
  const trimmedName = form.name.trim();
  if (trimmedName === "") errors.push("name is required");
  else if (!NAME_PATTERN.test(trimmedName)) {
    errors.push("name contains invalid characters");
  } else if (existingNames.includes(trimmedName)) {
    errors.push("name already exists");
  }

  if (form.transport === "stdio") {
    if (form.command.trim() === "") errors.push("command is required for stdio");
  } else {
    if (form.url.trim() === "") errors.push("url is required for sse/http");
  }
  return errors;
}

/** Compose the form into the JSON spec the IPC writes to ~/.claude.json. */
export function buildMcpSpec(form: AddMcpForm): McpServerSpec {
  if (form.transport === "stdio") {
    const args = form.args
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const env = Object.fromEntries(
      form.env
        .map(({ key, value }) => [key.trim(), value.trim()])
        .filter(([k]) => k.length > 0),
    );
    return {
      type: "stdio",
      command: form.command.trim(),
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  // sse/http: same shape, headers optional.
  const headers = Object.fromEntries(
    form.headers
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.includes(":"))
      .map((s) => {
        const idx = s.indexOf(":");
        return [s.slice(0, idx).trim(), s.slice(idx + 1).trim()];
      }),
  );
  return {
    type: form.transport,
    url: form.url.trim(),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

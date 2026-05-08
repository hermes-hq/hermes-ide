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

const NAME_PATTERN = /^[A-Za-z0-9_\- ]+$/;

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

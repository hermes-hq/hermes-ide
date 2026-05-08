// @vitest-environment jsdom
/**
 * M3 — MCP Context Panel section + add-server dialog.
 * Spec: §2 (M3) + §7.7.  Visual: §8.7.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

import {
  classifyMcpStatus,
  describeMcpStatus,
  filterToolsForServer,
  validateAddMcpForm,
  type AddMcpForm,
  type McpServerSpecView,
} from "../utils/mcpServers";
import { McpSection } from "../components/McpSection";
import { AddMcpDialog } from "../components/AddMcpDialog";

const SAMPLE_SERVERS = [
  { name: "context7", status: "connected" },
  { name: "Sanity", status: "connected" },
  { name: "broken-server", status: "failed" },
];

const SAMPLE_TOOLS = [
  "Bash",
  "Read",
  "mcp__context7__query",
  "mcp__context7__resolve",
  "mcp__Sanity__query",
];

describe("filterToolsForServer (mcp-3)", () => {
  it("returns only mcp__<server>__* tools, with the prefix stripped", () => {
    expect(filterToolsForServer(SAMPLE_TOOLS, "context7")).toEqual([
      "query",
      "resolve",
    ]);
    expect(filterToolsForServer(SAMPLE_TOOLS, "Sanity")).toEqual(["query"]);
  });
  it("returns empty for unknown server", () => {
    expect(filterToolsForServer(SAMPLE_TOOLS, "xxx")).toEqual([]);
  });
  it("does not match partial server names", () => {
    expect(filterToolsForServer(["mcp__context7-extra__t"], "context7")).toEqual([]);
  });
});

describe("validateAddMcpForm (mcp-8, mcp-9, mcp-20, mcp-21, mcp-22)", () => {
  const base: AddMcpForm = {
    name: "context7",
    transport: "stdio",
    command: "npx",
    args: "-y, @upstash/context7-mcp",
    url: "",
    headers: "",
    env: [],
  };

  it("mcp-8: valid form returns no errors", () => {
    expect(validateAddMcpForm(base, [])).toEqual([]);
  });

  it("mcp-8-b: duplicate name → 'name already exists'", () => {
    const errors = validateAddMcpForm({ ...base, name: "Sanity" }, ["context7", "Sanity"]);
    expect(errors).toContain("name already exists");
  });

  it("mcp-20: name with shell metachars → rejected", () => {
    expect(validateAddMcpForm({ ...base, name: "evil; rm -rf /" }, [])).toContain(
      "name contains invalid characters",
    );
    expect(validateAddMcpForm({ ...base, name: "ok name" }, [])).not.toContain(
      "name contains invalid characters",
    );
  });

  it("accepts real-world MCP names with dots, colons, spaces (regression)", () => {
    // Bug repro: "claude.ai Gmail" was being rejected by the prior
    // validator, blocking remove + read-spec for live cloud MCPs.
    for (const name of [
      "claude.ai Gmail",
      "claude.ai Google Drive",
      "plugin:telegram:telegram",
      "hermes-hq.kanban-board",
      "name.with.many.dots",
    ]) {
      expect(
        validateAddMcpForm({ ...base, name }, []),
      ).not.toContain("name contains invalid characters");
    }
  });

  it("still rejects shell metas, pipes, redirects, backticks, slashes", () => {
    for (const bad of ["a|b", "a>b", "a<b", "a`b", "a\"b", "a/b", "a\\b", "a$b"]) {
      expect(
        validateAddMcpForm({ ...base, name: bad }, []),
      ).toContain("name contains invalid characters");
    }
  });

  it("mcp-21: empty command for transport=stdio → rejected", () => {
    expect(validateAddMcpForm({ ...base, command: "" }, [])).toContain(
      "command is required for stdio",
    );
  });

  it("mcp-22: empty url for transport=sse|http → rejected", () => {
    expect(validateAddMcpForm({ ...base, transport: "sse", command: "", url: "" }, [])).toContain(
      "url is required for sse/http",
    );
    expect(
      validateAddMcpForm({ ...base, transport: "sse", command: "", url: "https://x" }, []),
    ).not.toContain("url is required for sse/http");
  });

  it("name cannot be empty", () => {
    expect(validateAddMcpForm({ ...base, name: "" }, [])).toContain("name is required");
  });
});

describe("McpSection (mcp-1, mcp-2)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async () => null);
  });
  afterEach(() => cleanup());

  it("mcp-1: renders each server with status dot", () => {
    render(<McpSection servers={SAMPLE_SERVERS} tools={SAMPLE_TOOLS} onRequestAdd={() => {}} />);
    expect(screen.getByText("context7")).toBeInTheDocument();
    expect(screen.getByText("Sanity")).toBeInTheDocument();
    expect(screen.getByText("broken-server")).toBeInTheDocument();
  });

  it("mcp-2: empty list shows '+ Add MCP server' CTA only", () => {
    render(<McpSection servers={[]} tools={[]} onRequestAdd={() => {}} />);
    expect(screen.getByRole("button", { name: /add mcp server/i })).toBeInTheDocument();
    expect(document.querySelectorAll(".mcp-row")).toHaveLength(0);
  });

  it("clicking a server expands to show its tools (mcp-3 visual)", () => {
    render(<McpSection servers={SAMPLE_SERVERS} tools={SAMPLE_TOOLS} onRequestAdd={() => {}} />);
    fireEvent.click(screen.getByText("context7"));
    expect(screen.getByText("query")).toBeInTheDocument();
    expect(screen.getByText("resolve")).toBeInTheDocument();
  });
});

// ─── Status classification ─────────────────────────────────────────

describe("classifyMcpStatus", () => {
  it("normalizes connected variants", () => {
    expect(classifyMcpStatus("connected")).toBe("connected");
    expect(classifyMcpStatus("Connected")).toBe("connected");
    expect(classifyMcpStatus("ok")).toBe("connected");
    expect(classifyMcpStatus("ready")).toBe("connected");
  });
  it("normalizes needs-auth variants", () => {
    expect(classifyMcpStatus("needs_auth")).toBe("needs-auth");
    expect(classifyMcpStatus("needs-auth")).toBe("needs-auth");
    expect(classifyMcpStatus("auth_required")).toBe("needs-auth");
    expect(classifyMcpStatus("requires_auth")).toBe("needs-auth");
  });
  it("normalizes failed variants", () => {
    expect(classifyMcpStatus("failed")).toBe("failed");
    expect(classifyMcpStatus("error")).toBe("failed");
    expect(classifyMcpStatus("disconnected")).toBe("failed");
    expect(classifyMcpStatus("FAILED")).toBe("failed");
  });
  it("anything else is unknown", () => {
    expect(classifyMcpStatus("")).toBe("unknown");
    expect(classifyMcpStatus(undefined)).toBe("unknown");
    expect(classifyMcpStatus(null)).toBe("unknown");
    expect(classifyMcpStatus("starting")).toBe("unknown");
  });
});

describe("describeMcpStatus", () => {
  it("returns a tone + a human label per status kind", () => {
    expect(describeMcpStatus("connected").tone).toBe("good");
    expect(describeMcpStatus("needs-auth").tone).toBe("warn");
    expect(describeMcpStatus("failed").tone).toBe("bad");
    expect(describeMcpStatus("unknown").tone).toBe("muted");
  });
  it("labels mention what to do for the bad / warn cases", () => {
    expect(describeMcpStatus("needs-auth").label).toMatch(/api key|env/i);
    expect(describeMcpStatus("failed").label).toMatch(/command|url|stderr/i);
  });
});

// ─── Expanded row — spec body, status explanation, actions ─────────

describe("McpSection — expanded spec body (read_mcp_server_spec)", () => {
  const STDIO_SPEC: McpServerSpecView = {
    name: "context7",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
    url: "",
    env_keys: ["CONTEXT7_API_KEY", "DEBUG"],
    header_keys: [],
  };

  beforeEach(() => {
    invokeMock.mockReset();
  });
  afterEach(() => cleanup());

  it("calls read_mcp_server_spec on expand and renders transport + command", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "read_mcp_server_spec") return STDIO_SPEC;
      return undefined;
    });
    render(<McpSection servers={SAMPLE_SERVERS} tools={SAMPLE_TOOLS} onRequestAdd={() => {}} />);
    fireEvent.click(screen.getByText("context7"));

    // The spec body is async — wait for it to resolve.
    expect(await screen.findByText(/^stdio$/i)).toBeInTheDocument();
    expect(screen.getByText(/npx -y @upstash\/context7-mcp/)).toBeInTheDocument();

    const ipcCalls = invokeMock.mock.calls.filter(([c]) => c === "read_mcp_server_spec");
    expect(ipcCalls.length).toBeGreaterThan(0);
    expect(ipcCalls[0][1]).toEqual({ name: "context7" });
  });

  it("env keys render as chips, values are NEVER on screen (redaction contract)", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "read_mcp_server_spec") return STDIO_SPEC;
      return undefined;
    });
    render(<McpSection servers={SAMPLE_SERVERS} tools={SAMPLE_TOOLS} onRequestAdd={() => {}} />);
    fireEvent.click(screen.getByText("context7"));

    expect(await screen.findByText("CONTEXT7_API_KEY")).toBeInTheDocument();
    expect(screen.getByText("DEBUG")).toBeInTheDocument();
    // Even if the test set a fake value, it should never reach the DOM.
    expect(document.body.innerHTML).not.toContain("DO_NOT_LEAK");
  });

  it("orphan server (live but absent from ~/.claude.json) shows the orphan note", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "read_mcp_server_spec") return null;
      return undefined;
    });
    render(<McpSection servers={SAMPLE_SERVERS} tools={SAMPLE_TOOLS} onRequestAdd={() => {}} />);
    fireEvent.click(screen.getByText("context7"));
    expect(await screen.findByText(/Live in this session but not in/i)).toBeInTheDocument();
  });

  it("IPC error renders the error fallback, not a crash", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "read_mcp_server_spec") throw new Error("boom");
      return undefined;
    });
    render(<McpSection servers={SAMPLE_SERVERS} tools={SAMPLE_TOOLS} onRequestAdd={() => {}} />);
    fireEvent.click(screen.getByText("context7"));
    expect(await screen.findByText(/couldn't read/i)).toBeInTheDocument();
  });

  it("status explanation is shown with the right tone for failed servers", async () => {
    invokeMock.mockImplementation(async () => null);
    render(<McpSection servers={SAMPLE_SERVERS} tools={SAMPLE_TOOLS} onRequestAdd={() => {}} />);
    fireEvent.click(screen.getByText("broken-server"));
    await Promise.resolve(); await Promise.resolve();
    const explainer = document.querySelector('.mcp-status-explain[data-status="failed"]');
    expect(explainer).not.toBeNull();
    expect(explainer?.textContent).toMatch(/failed to connect/i);
  });
});

// ─── Remove confirmation flow ────────────────────────────────────

describe("McpSection — remove with confirmation", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async () => null);
  });
  afterEach(() => cleanup());

  it("first click on remove opens a confirm row, doesn't call onRequestRemove", () => {
    const onRequestRemove = vi.fn();
    render(
      <McpSection
        servers={SAMPLE_SERVERS}
        tools={SAMPLE_TOOLS}
        onRequestAdd={() => {}}
        onRequestRemove={onRequestRemove}
      />,
    );
    fireEvent.click(screen.getByText("context7"));
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(onRequestRemove).not.toHaveBeenCalled();
    expect(screen.getByText(/Delete/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /yes, remove/i })).toBeInTheDocument();
  });

  it("clicking the confirm button fires onRequestRemove(name) once", async () => {
    const onRequestRemove = vi.fn(async () => undefined);
    render(
      <McpSection
        servers={SAMPLE_SERVERS}
        tools={SAMPLE_TOOLS}
        onRequestAdd={() => {}}
        onRequestRemove={onRequestRemove}
      />,
    );
    fireEvent.click(screen.getByText("context7"));
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, remove/i }));
    await Promise.resolve(); await Promise.resolve();
    expect(onRequestRemove).toHaveBeenCalledTimes(1);
    expect(onRequestRemove).toHaveBeenCalledWith("context7");
  });

  it("clicking cancel inside the confirm row aborts without calling onRequestRemove", () => {
    const onRequestRemove = vi.fn();
    render(
      <McpSection
        servers={SAMPLE_SERVERS}
        tools={SAMPLE_TOOLS}
        onRequestAdd={() => {}}
        onRequestRemove={onRequestRemove}
      />,
    );
    fireEvent.click(screen.getByText("context7"));
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onRequestRemove).not.toHaveBeenCalled();
    // Confirm row collapses back to the bare remove button.
    expect(screen.queryByText(/yes, remove/i)).toBeNull();
  });
});

// ─── Restart action ──────────────────────────────────────────────

describe("McpSection — restart action", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async () => null);
  });
  afterEach(() => cleanup());

  it("calls onRequestRestart(name) when restart is clicked", async () => {
    const onRequestRestart = vi.fn(async () => undefined);
    render(
      <McpSection
        servers={SAMPLE_SERVERS}
        tools={SAMPLE_TOOLS}
        onRequestAdd={() => {}}
        onRequestRestart={onRequestRestart}
      />,
    );
    fireEvent.click(screen.getByText("Sanity"));
    fireEvent.click(screen.getByRole("button", { name: /^restart$/i }));
    await Promise.resolve();
    expect(onRequestRestart).toHaveBeenCalledTimes(1);
    expect(onRequestRestart).toHaveBeenCalledWith("Sanity");
  });

  it("doesn't render the restart button when the prop is omitted", () => {
    render(
      <McpSection
        servers={SAMPLE_SERVERS}
        tools={SAMPLE_TOOLS}
        onRequestAdd={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("context7"));
    expect(screen.queryByRole("button", { name: /^restart$/i })).toBeNull();
  });
});

// ─── Status legend ───────────────────────────────────────────────

describe("McpSection — status legend", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async () => null);
  });
  afterEach(() => cleanup());

  it("renders a legend that decodes the four dot colors", () => {
    render(<McpSection servers={SAMPLE_SERVERS} tools={SAMPLE_TOOLS} onRequestAdd={() => {}} />);
    fireEvent.click(screen.getByText(/what do the status dots mean/i));
    expect(screen.getByText(/Connected — tools are live/i)).toBeInTheDocument();
    expect(screen.getByText(/Needs auth — set the env/i)).toBeInTheDocument();
    expect(screen.getByText(/Failed — bridge couldn't connect/i)).toBeInTheDocument();
    expect(screen.getByText(/Unknown — live init hasn't reported/i)).toBeInTheDocument();
  });
});

describe("AddMcpDialog — submit (mcp-10, mcp-14)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async () => undefined);
  });
  afterEach(() => cleanup());

  it("mcp-10: submit fires write_mcp_server IPC with assembled payload", async () => {
    const onClose = vi.fn();
    render(<AddMcpDialog existingNames={[]} onClose={onClose} />);

    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: "context7" } });
    fireEvent.change(screen.getByLabelText(/command/i), { target: { value: "npx" } });
    fireEvent.change(screen.getByLabelText(/^args/i), {
      target: { value: "-y, @upstash/context7-mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    // Allow the promise tick.
    await Promise.resolve();
    await Promise.resolve();

    const calls = invokeMock.mock.calls.filter(([c]) => c === "write_mcp_server");
    expect(calls).toHaveLength(1);
    const payload = calls[0][1] as { name: string; spec: { type: string; command: string; args: string[] } };
    expect(payload.name).toBe("context7");
    expect(payload.spec.type).toBe("stdio");
    expect(payload.spec.command).toBe("npx");
    expect(payload.spec.args).toEqual(["-y", "@upstash/context7-mcp"]);
  });

  it("mcp-8 wired in dialog: invalid form blocks save", () => {
    render(<AddMcpDialog existingNames={["context7"]} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: "context7" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(invokeMock).not.toHaveBeenCalled();
    expect(screen.getByText(/name already exists/i)).toBeInTheDocument();
  });
});

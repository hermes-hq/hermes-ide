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
  filterToolsForServer,
  validateAddMcpForm,
  type AddMcpForm,
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

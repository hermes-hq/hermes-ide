// @vitest-environment jsdom
/**
 * GenericToolBlock — fallback renderer.
 *
 * The previous renderer dumped pretty-printed JSON inside an
 * unbounded `<pre>` element with no collapse affordance.  The
 * redesigned version surfaces a one-line summary inline with the
 * tool name; the full payload is hidden behind a disclosure that
 * mounts a syntax-highlighted CodeFence on demand.
 *
 * These tests pin: (a) the summary chip surfaces the right hint
 * given the tool's input shape, (b) the JSON code fence is NOT in
 * the DOM until the user clicks "input", (c) long results get
 * their own disclosure rather than rendering inline.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { GenericToolBlock } from "../agent/blocks/GenericToolBlock";
import type { ToolResultBlockData, ToolUseBlockData } from "../agent/types";

function tu(name: string, input: unknown): ToolUseBlockData {
  return {
    type: "tool_use",
    id: "tu_test",
    name,
    input: input as Record<string, unknown>,
  };
}

function tr(content: string | ToolResultBlockData["content"], isError = false): ToolResultBlockData {
  return {
    type: "tool_result",
    tool_use_id: "tu_test",
    content,
    is_error: isError,
  };
}

describe("GenericToolBlock — input summary chip", () => {
  afterEach(() => cleanup());

  it("surfaces a `command:` hint when input has a Bash-like shape", () => {
    render(<GenericToolBlock block={tu("MystTool", { command: "ls -la" })} result={undefined} />);
    expect(screen.getByText(/command: ls -la/)).toBeInTheDocument();
  });

  it("surfaces just the path when input has a file_path shape", () => {
    render(<GenericToolBlock block={tu("MystTool", { file_path: "/etc/hosts" })} result={undefined} />);
    expect(screen.getByText("/etc/hosts")).toBeInTheDocument();
  });

  it("falls back to key count on generic shapes", () => {
    render(<GenericToolBlock block={tu("MystTool", { a: 1, b: 2 })} result={undefined} />);
    expect(screen.getByText(/^2 keys · /)).toBeInTheDocument();
  });

  it("renders empty marker for an empty input object", () => {
    render(<GenericToolBlock block={tu("MystTool", {})} result={undefined} />);
    expect(screen.getByText(/empty object/i)).toBeInTheDocument();
  });
});

describe("GenericToolBlock — input disclosure", () => {
  afterEach(() => cleanup());

  it("does NOT render the code fence until the user clicks `input`", () => {
    render(
      <GenericToolBlock
        block={tu("MystTool", { command: "ls" })}
        result={undefined}
      />,
    );
    // No <code> element with hljs class in the initial render.
    expect(document.querySelector(".hljs")).toBeNull();
  });

  it("clicking the toggle reveals the highlighted JSON fence", () => {
    render(
      <GenericToolBlock
        block={tu("MystTool", { command: "ls" })}
        result={undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /show tool input|hide tool input/i }));
    // After click, the toggle says "hide" and the JSON fence is mounted.
    expect(screen.getByRole("button", { name: /hide tool input/i })).toBeInTheDocument();
    expect(document.querySelector(".agent-tool-generic-input-body .agent-code-fence")).not.toBeNull();
  });

  it("clicking again collapses the fence back", () => {
    render(
      <GenericToolBlock
        block={tu("MystTool", { command: "ls" })}
        result={undefined}
      />,
    );
    const btn = screen.getByRole("button", { name: /show tool input/i });
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole("button", { name: /hide tool input/i }));
    expect(document.querySelector(".agent-tool-generic-input-body")).toBeNull();
  });

  it("aria-expanded stays in sync with disclosure state", () => {
    render(
      <GenericToolBlock
        block={tu("MystTool", { command: "ls" })}
        result={undefined}
      />,
    );
    const btn = screen.getByRole("button", { name: /input/i });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
  });
});

describe("GenericToolBlock — result rendering", () => {
  afterEach(() => cleanup());

  it("short result renders inline without a disclosure", () => {
    render(
      <GenericToolBlock
        block={tu("MystTool", { command: "ls" })}
        result={tr("ok")}
      />,
    );
    expect(screen.getByText("ok")).toBeInTheDocument();
    expect(screen.queryByText(/result · /)).toBeNull();
  });

  it("long result (>240 chars) is wrapped in a <details> with a `result · N lines` summary", () => {
    const longResult = "line\n".repeat(20) + "x".repeat(300);
    render(
      <GenericToolBlock
        block={tu("MystTool", { command: "ls" })}
        result={tr(longResult)}
      />,
    );
    // Disclosure summary present.
    expect(screen.getByText(/result · \d+ lines/)).toBeInTheDocument();
  });

  it("running tool (no result yet) shows data-status=running", () => {
    const { container } = render(
      <GenericToolBlock block={tu("MystTool", {})} result={undefined} />,
    );
    expect(container.querySelector('[data-status="running"]')).not.toBeNull();
  });

  it("error result sets data-status=error", () => {
    const { container } = render(
      <GenericToolBlock
        block={tu("MystTool", {})}
        result={tr("boom", true)}
      />,
    );
    expect(container.querySelector('[data-status="error"]')).not.toBeNull();
  });

  it("success result sets data-status=success", () => {
    const { container } = render(
      <GenericToolBlock
        block={tu("MystTool", {})}
        result={tr("ok")}
      />,
    );
    expect(container.querySelector('[data-status="success"]')).not.toBeNull();
  });
});

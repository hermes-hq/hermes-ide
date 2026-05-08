// @vitest-environment jsdom
/**
 * M4 — Memory section.  Spec: §2 (M4) + §7.8.  Visual: §8.8.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

import { classifyMemoryPath } from "../utils/memoryPaths";
import { MemorySection } from "../components/MemorySection";

describe("classifyMemoryPath (mem-1)", () => {
  it("classifies user paths under ~/.claude", () => {
    const home = process.env.HOME ?? "/Users/dev";
    expect(classifyMemoryPath(`${home}/.claude/CLAUDE.md`)).toBe("user");
  });
  it("classifies anything else as project", () => {
    expect(classifyMemoryPath("/Users/dev/proj/CLAUDE.md")).toBe("project");
  });
});

describe("MemorySection — render (mem-1, mem-5)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "read_memory_file") {
        const path = (args as { path: string }).path;
        if (path.includes("missing")) throw new Error("not found");
        return "# Project context\n\n## Conventions\n- prefer rg over grep";
      }
      return undefined;
    });
  });
  afterEach(() => cleanup());

  it("mem-1: renders each memory_path with classification label", () => {
    const home = process.env.HOME ?? "/Users/dev";
    render(
      <MemorySection
        memoryPaths={[
          `${home}/.claude/CLAUDE.md`,
          "/Users/dev/proj/CLAUDE.md",
        ]}
      />,
    );
    expect(screen.getByText("user")).toBeInTheDocument();
    expect(screen.getByText("project")).toBeInTheDocument();
  });

  it("mem-1-b: empty memory_paths shows + Add CTA only", () => {
    render(<MemorySection memoryPaths={[]} />);
    expect(screen.getByRole("button", { name: /add memory line/i })).toBeInTheDocument();
  });

  it("mem-2: clicking row opens inline editor with file content", async () => {
    render(<MemorySection memoryPaths={["/Users/dev/proj/CLAUDE.md"]} />);
    fireEvent.click(screen.getByText(/CLAUDE.md/));
    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain("Project context");
  });

  it("mem-3: save writes via write_memory_file IPC", async () => {
    render(<MemorySection memoryPaths={["/Users/dev/proj/CLAUDE.md"]} />);
    fireEvent.click(screen.getByText(/CLAUDE.md/));
    const ta = await waitFor(() => screen.getByRole("textbox") as HTMLTextAreaElement);
    fireEvent.change(ta, { target: { value: "# new content" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => {
      const saved = invokeMock.mock.calls.find(([c]) => c === "write_memory_file");
      expect(saved).toBeDefined();
      expect((saved![1] as { content: string }).content).toBe("# new content");
    });
  });

  it("mem-5: missing file → 'create now' CTA shown", async () => {
    render(<MemorySection memoryPaths={["/missing/CLAUDE.md"]} />);
    fireEvent.click(screen.getByText(/CLAUDE.md/));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /create now/i })).toBeInTheDocument();
    });
  });
});

// @vitest-environment jsdom
/**
 * M5 — Permissions section.  Spec: §2 (M5) + §7.9.  Visual: §8.9.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

import {
  classifyRule,
  testPattern,
  type PermissionRule,
} from "../utils/permissionsRules";
import { PermissionsSection } from "../components/PermissionsSection";

const SAMPLE_RULES: PermissionRule[] = [
  { pattern: "Bash(git status:*)", source: "project", kind: "allow" },
  { pattern: "Read(src/**)", source: "user", kind: "allow" },
  { pattern: "Bash(rm -rf:*)", source: "user", kind: "deny" },
];

describe("classifyRule (perm-1)", () => {
  it("groups allow vs deny", () => {
    const groups = SAMPLE_RULES.reduce(
      (acc, r) => {
        const k = classifyRule(r);
        acc[k].push(r.pattern);
        return acc;
      },
      { allow: [] as string[], deny: [] as string[] },
    );
    expect(groups.allow).toContain("Bash(git status:*)");
    expect(groups.deny).toContain("Bash(rm -rf:*)");
  });
});

describe("testPattern (perm-6, perm-7, perm-15)", () => {
  it("perm-6: returns allow when pattern matches an allow rule", () => {
    expect(testPattern("Bash(git status --short)", SAMPLE_RULES)).toEqual({
      verdict: "allow",
      source: "project",
      pattern: "Bash(git status:*)",
    });
  });
  it("perm-6-b: returns deny when matches a deny rule", () => {
    expect(testPattern("Bash(rm -rf /)", SAMPLE_RULES)).toEqual({
      verdict: "deny",
      source: "user",
      pattern: "Bash(rm -rf:*)",
    });
  });
  it("perm-6-c: returns no-match when nothing matches", () => {
    expect(testPattern("WebFetch(example.com)", SAMPLE_RULES)).toEqual({
      verdict: "no-match",
    });
  });
  it("perm-7: project deny shadows user allow", () => {
    const rules: PermissionRule[] = [
      { pattern: "Bash(make:*)", source: "user", kind: "allow" },
      { pattern: "Bash(make:*)", source: "project", kind: "deny" },
    ];
    expect(testPattern("Bash(make build)", rules).verdict).toBe("deny");
  });
  it("perm-15: unparseable input returns no-match (no crash)", () => {
    expect(testPattern("", SAMPLE_RULES).verdict).toBe("no-match");
  });
});

describe("PermissionsSection — render (perm-2)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async () => undefined);
  });
  afterEach(() => cleanup());

  it("perm-2: renders allow + deny columns with source labels", () => {
    render(<PermissionsSection rules={SAMPLE_RULES} />);
    expect(screen.getByText("Bash(git status:*)")).toBeInTheDocument();
    expect(screen.getByText("Read(src/**)")).toBeInTheDocument();
    expect(screen.getByText("Bash(rm -rf:*)")).toBeInTheDocument();
    expect(screen.getAllByText("user").length).toBeGreaterThan(0);
    expect(screen.getAllByText("project").length).toBeGreaterThan(0);
  });

  it("perm-2-b: empty rules show + Add CTA only", () => {
    render(<PermissionsSection rules={[]} />);
    expect(screen.getByRole("button", { name: /add rule/i })).toBeInTheDocument();
  });

  it("perm-6: test-pattern input shows live verdict", () => {
    render(<PermissionsSection rules={SAMPLE_RULES} />);
    const input = screen.getByPlaceholderText(/test pattern/i);
    fireEvent.change(input, { target: { value: "Bash(git status)" } });
    // The Verdict component renders "allow (project)" — assert the
    // specific verdict cell, not just any "allow" string.
    expect(screen.getByText(/allow \(project\)/i)).toBeInTheDocument();
  });

  it("perm-3, perm-4: add-rule dialog writes via write_permission_rule IPC", async () => {
    render(<PermissionsSection rules={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /add rule/i }));
    const patternInput = await waitFor(() => screen.getByLabelText(/pattern/i));
    fireEvent.change(patternInput, { target: { value: "Bash(npm test:*)" } });
    fireEvent.click(screen.getByRole("button", { name: /^save rule$/i }));
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([c]) => c === "write_permission_rule");
      expect(calls.length).toBe(1);
      expect(calls[0][1]).toMatchObject({
        pattern: "Bash(npm test:*)",
        kind: "allow",
        scope: "user",
      });
    });
  });
});

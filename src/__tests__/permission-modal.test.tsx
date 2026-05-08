// @vitest-environment jsdom
/**
 * M1c — canUseTool permission modal.  Spec §2 (M1c) + §7.5.  Visual §8.4.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import {
  isPermRequest,
  buildPermResponse,
  buildApproveAllAllowRule,
} from "../utils/permissionRequest";
import { PermissionRequestModal } from "../components/PermissionRequestModal";

const SAMPLE_REQUEST = {
  type: "_hermes_perm_request" as const,
  id: "req_1",
  toolName: "Bash",
  input: { command: "git status --short", description: "status check" },
};

describe("isPermRequest (pm-2)", () => {
  it("recognises _hermes_perm_request envelopes", () => {
    expect(isPermRequest(SAMPLE_REQUEST)).toBe(true);
  });
  it("rejects malformed envelopes", () => {
    expect(isPermRequest({ type: "user", id: "x", toolName: "y" })).toBe(false);
    expect(isPermRequest(null)).toBe(false);
    expect(isPermRequest({ type: "_hermes_perm_request", id: "x" } as never)).toBe(false);
  });
});

describe("buildPermResponse (pm-4, pm-5)", () => {
  it("pm-4: allow → behavior=allow + updatedInput", () => {
    expect(buildPermResponse("req_1", { kind: "allow" })).toEqual({
      type: "_hermes_perm_response",
      id: "req_1",
      decision: { behavior: "allow" },
    });
  });
  it("pm-4-b: allow with edited input passes updatedInput through", () => {
    const edited = { command: "git status" };
    expect(buildPermResponse("req_1", { kind: "allow", updatedInput: edited })).toEqual({
      type: "_hermes_perm_response",
      id: "req_1",
      decision: { behavior: "allow", updatedInput: edited },
    });
  });
  it("pm-5: deny → behavior=deny + message", () => {
    expect(buildPermResponse("req_1", { kind: "deny" })).toEqual({
      type: "_hermes_perm_response",
      id: "req_1",
      decision: { behavior: "deny", message: "user declined" },
    });
  });
});

describe("buildApproveAllAllowRule (pm-8)", () => {
  it("Bash with command field → 'Bash(<cmd>:*)'", () => {
    expect(buildApproveAllAllowRule("Bash", { command: "git status" })).toBe("Bash(git status:*)");
  });
  it("Read with file_path → 'Read(<path>)'", () => {
    expect(buildApproveAllAllowRule("Read", { file_path: "src/x.ts" })).toBe("Read(src/x.ts)");
  });
  it("unknown tool → bare tool name", () => {
    expect(buildApproveAllAllowRule("Foo", { x: 1 })).toBe("Foo");
  });
});

describe("PermissionRequestModal (pm-6, pm-7)", () => {
  afterEach(() => cleanup());

  it("pm-6: renders tool name and input", () => {
    render(
      <PermissionRequestModal
        request={SAMPLE_REQUEST}
        permissionMode="default"
        onDecision={() => {}}
      />,
    );
    // "Bash" appears in both the dd cell and the "Approve all (Bash)"
    // button — both are valid; assert at least one each.
    expect(screen.getAllByText("Bash").length).toBeGreaterThan(0);
    expect(screen.getByText(/git status --short/)).toBeInTheDocument();
  });

  it("pm-7: shows approve, approve-all, deny, edit buttons", () => {
    render(
      <PermissionRequestModal
        request={SAMPLE_REQUEST}
        permissionMode="default"
        onDecision={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /approve once/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve all/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deny/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
  });

  it("approve-once → onDecision({kind:'allow'})", () => {
    const onDecision = vi.fn();
    render(
      <PermissionRequestModal
        request={SAMPLE_REQUEST}
        permissionMode="default"
        onDecision={onDecision}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /approve once/i }));
    expect(onDecision).toHaveBeenCalledWith({ kind: "allow" });
  });

  it("deny → onDecision({kind:'deny'})", () => {
    const onDecision = vi.fn();
    render(
      <PermissionRequestModal
        request={SAMPLE_REQUEST}
        permissionMode="default"
        onDecision={onDecision}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^deny$/i }));
    expect(onDecision).toHaveBeenCalledWith({ kind: "deny" });
  });

  it("approve-all → onDecision({kind:'allow', persist: rule})", () => {
    const onDecision = vi.fn();
    render(
      <PermissionRequestModal
        request={SAMPLE_REQUEST}
        permissionMode="default"
        onDecision={onDecision}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /approve all/i }));
    expect(onDecision).toHaveBeenCalledWith({
      kind: "allow",
      persist: "Bash(git status --short:*)",
    });
  });

  it("pm-12: bypassPermissions mode auto-allows immediately on mount", () => {
    const onDecision = vi.fn();
    render(
      <PermissionRequestModal
        request={SAMPLE_REQUEST}
        permissionMode="bypassPermissions"
        onDecision={onDecision}
      />,
    );
    expect(onDecision).toHaveBeenCalledWith({ kind: "allow" });
  });

  it("edit → reveals JSON textarea; revalidate before approve", () => {
    const onDecision = vi.fn();
    render(
      <PermissionRequestModal
        request={SAMPLE_REQUEST}
        permissionMode="default"
        onDecision={onDecision}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta.value).toContain("git status");

    // Type invalid JSON → confirm-edit blocked.
    fireEvent.change(ta, { target: { value: "{ broken" } });
    const confirm = screen.getByRole("button", { name: /confirm edit/i });
    expect(confirm).toBeDisabled();

    // Fix: valid JSON enables confirm.
    fireEvent.change(ta, { target: { value: '{"command":"git status"}' } });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    expect(onDecision).toHaveBeenCalledWith({
      kind: "allow",
      updatedInput: { command: "git status" },
    });
  });
});

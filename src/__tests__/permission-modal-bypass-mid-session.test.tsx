// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

afterEach(() => cleanup());
import { PermissionRequestModal } from "../components/PermissionRequestModal";
import type { PermRequest } from "../utils/permissionRequest";

const REQ: PermRequest = {
  type: "_hermes_perm_request",
  id: "perm-1",
  toolName: "Bash",
  input: { command: "rm -rf /" },
};

describe("PermissionRequestModal — mid-session bypass (regression)", () => {
  it("auto-allows when permissionMode prop changes to bypassPermissions after mount", () => {
    const onDecision = vi.fn();
    const view = render(
      <PermissionRequestModal request={REQ} permissionMode="default" onDecision={onDecision} />,
    );
    expect(onDecision).not.toHaveBeenCalled();
    view.rerender(
      <PermissionRequestModal request={REQ} permissionMode="bypassPermissions" onDecision={onDecision} />,
    );
    expect(onDecision).toHaveBeenCalledWith({ kind: "allow" });
    expect(view.container.querySelector(".perm-modal")).toBeNull();
  });

  it("does NOT auto-allow when permissionMode stays on default", () => {
    const onDecision = vi.fn();
    render(<PermissionRequestModal request={REQ} permissionMode="default" onDecision={onDecision} />);
    expect(onDecision).not.toHaveBeenCalled();
  });
});

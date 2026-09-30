// @vitest-environment jsdom
/**
 * A changed file's row actions: the control set's buttons in the Review
 * Desk's Changes section (kit), the Git panel's own buttons elsewhere.
 * Discard asks first; only Confirm discards.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { GitFileRow } from "../components/GitFileRow";
import type { GitFile } from "../types/git";

afterEach(cleanup);

const modified: GitFile = { path: "src/app.js", status: "modified", area: "unstaged", old_path: null };
const staged: GitFile = { path: "README.md", status: "modified", area: "staged", old_path: null };

function setup(file: GitFile, kit: boolean) {
  const handlers = { onStage: vi.fn(), onUnstage: vi.fn(), onDiscard: vi.fn(), onOpen: vi.fn(), onClick: vi.fn() };
  render(<GitFileRow file={file} kit={kit} {...handlers} />);
  return handlers;
}

const buttons = () => screen.getAllByRole("button");

describe("GitFileRow actions", () => {
  it("kit: Open, Discard and Stage are small control-set buttons that do their action", () => {
    const h = setup(modified, true);
    expect(buttons().map((b) => b.textContent)).toEqual(["Open", "Discard", "Stage"]);
    for (const b of buttons()) {
      expect(b).toHaveClass("h-btn", "h-btn--sm");
      expect(b).not.toHaveClass("git-file-btn");
      expect(b).toHaveAttribute("type", "button");
    }
    fireEvent.click(screen.getByRole("button", { name: "Stage" }));
    expect(h.onStage).toHaveBeenCalledWith("src/app.js");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(h.onOpen).toHaveBeenCalledWith("src/app.js");
    // A button press is not a click on the row.
    expect(h.onClick).not.toHaveBeenCalled();
  });

  it("kit: Discard asks with a danger Confirm and a quiet Cancel; Cancel keeps the file", () => {
    const h = setup(modified, true);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(h.onDiscard).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: "Confirm" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(confirm).toHaveClass("h-btn--danger", "git-file-action-discard-confirm");
    expect(cancel).toHaveClass("h-btn--quiet");
    fireEvent.click(cancel);
    expect(h.onDiscard).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(h.onDiscard).toHaveBeenCalledWith("src/app.js");
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  it("kit: a staged file offers Unstage", () => {
    const h = setup(staged, true);
    expect(buttons().map((b) => b.textContent)).toEqual(["Open", "Unstage"]);
    fireEvent.click(screen.getByRole("button", { name: "Unstage" }));
    expect(h.onUnstage).toHaveBeenCalledWith("README.md");
  });

  it("the Git panel keeps its own buttons", () => {
    setup(modified, false);
    for (const b of buttons()) {
      expect(b).toHaveClass("git-file-btn");
      expect(b).not.toHaveClass("h-btn");
    }
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveClass("git-file-btn-discard-confirm");
  });
});

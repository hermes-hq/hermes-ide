// @vitest-environment jsdom
/**
 * A new branch whose name differs from an existing one only in letter case
 * (Develop next to develop) is the SAME branch on macOS and Windows: git
 * hands back develop, and the session's commits move it. The New branch
 * form treats such a name as "already exists" on every OS, names the branch
 * that exists, and offers to use it on purpose; the step's Continue never
 * commits it as a new branch.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../api/git", () => ({
  gitListBranchesForProject: vi.fn(),
  listWorktrees: vi.fn(),
  checkBranchAvailable: vi.fn(),
  fetchRemoteBranches: vi.fn(),
}));

import { gitListBranchesForProject, listWorktrees, checkBranchAvailable } from "../api/git";
import { SessionBranchSelector, type BranchDraft } from "../components/SessionBranchSelector";
import { findBranchClash } from "../utils/branchClash";
import { I18nProvider } from "../i18n/I18nProvider";
import type { GitBranch, WorktreeInfo } from "../types/git";

const branch = (name: string, over: Partial<GitBranch> = {}): GitBranch => ({
  name,
  is_current: false,
  is_remote: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  last_commit_summary: null,
  ...over,
});

function setup(worktrees: WorktreeInfo[] = []) {
  vi.mocked(gitListBranchesForProject).mockResolvedValue([
    branch("main", { is_current: true }),
    branch("develop"),
    branch("feature/inbox"),
  ]);
  vi.mocked(listWorktrees).mockResolvedValue(worktrees);
  vi.mocked(checkBranchAvailable).mockResolvedValue({ available: true, usedBySession: null });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

async function openNewTab(props: { onBranchSelected?: ReturnType<typeof vi.fn>; onDraftChange?: (d: BranchDraft | null) => void } = {}) {
  const onBranchSelected = props.onBranchSelected ?? vi.fn();
  render(
    <SessionBranchSelector projectId="p1" onBranchSelected={onBranchSelected} onSkip={() => {}} onDraftChange={props.onDraftChange} />,
    { wrapper: I18nProvider },
  );
  await screen.findByText("develop");
  fireEvent.click(screen.getByRole("radio", { name: "New Branch" }));
  const field = await screen.findByPlaceholderText("feature/my-branch");
  onBranchSelected.mockClear();
  return { field, onBranchSelected };
}

describe("findBranchClash", () => {
  const existing = ["main", "develop", "feature/inbox"];
  it("tells an exact name, a case-only variant and a case-only folder apart", () => {
    expect(findBranchClash("develop", existing)).toEqual({ kind: "same", existing: "develop" });
    expect(findBranchClash("Develop", existing)).toEqual({ kind: "case", existing: "develop" });
    expect(findBranchClash("MAIN", existing)).toEqual({ kind: "case", existing: "main" });
    expect(findBranchClash("FEATURE/INBOX", existing)).toEqual({ kind: "case", existing: "feature/inbox" });
    expect(findBranchClash("Feature/other", existing)).toEqual({ kind: "folder", existing: "feature/inbox" });
    expect(findBranchClash("feature/other", existing)).toBeNull();
    expect(findBranchClash("developer", existing)).toBeNull();
    expect(findBranchClash("hermes/develop", existing)).toBeNull();
    // The exact name wins over a case-only one listed before it.
    expect(findBranchClash("Dev", ["dev", "Dev"])).toEqual({ kind: "same", existing: "Dev" });
  });
});

describe("New branch form: a case-only variant of an existing branch", () => {
  it("Develop next to develop: 'already exists', naming develop, and never a draft that can be created", async () => {
    setup();
    const drafts: (BranchDraft | null)[] = [];
    const { field, onBranchSelected } = await openNewTab({ onDraftChange: (d) => drafts.push(d) });
    fireEvent.change(field, { target: { value: "Develop" } });
    const error = await screen.findByText(/Branch develop already exists/);
    expect(error).toHaveTextContent("letter case");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: /Create & Use Branch/ })).toBeDisabled();
    expect(drafts.at(-1)).toEqual({ name: "Develop", ok: false });
    // Enter does not create it either.
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onBranchSelected).not.toHaveBeenCalled();
    // The availability check never ran for it (it is taken).
    await new Promise((r) => setTimeout(r, 350));
    expect(checkBranchAvailable).not.toHaveBeenCalledWith("p1", "Develop");
  });

  it("offers the existing branch: choosing it selects develop as an existing branch", async () => {
    setup();
    const { field, onBranchSelected } = await openNewTab();
    fireEvent.change(field, { target: { value: "Develop" } });
    fireEvent.click(await screen.findByRole("button", { name: "Use the existing develop" }));
    expect(onBranchSelected).toHaveBeenCalledTimes(1);
    expect(onBranchSelected).toHaveBeenCalledWith("develop", false);
  });

  it("the exact name also offers the existing branch; another name clears it", async () => {
    setup();
    const { field } = await openNewTab();
    fireEvent.change(field, { target: { value: "develop" } });
    expect(await screen.findByText("A branch named develop already exists")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use the existing develop" })).toBeInTheDocument();
    fireEvent.change(field, { target: { value: "develop-2" } });
    await waitFor(() => expect(screen.queryByText(/already exists/)).toBeNull());
    expect(screen.queryByRole("button", { name: /Use the existing/ })).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: /Create & Use Branch/ })).toBeEnabled());
  });

  it("a folder that differs only in case is refused, without a branch to use instead", async () => {
    setup();
    const { field } = await openNewTab();
    fireEvent.change(field, { target: { value: "Feature/new" } });
    expect(await screen.findByText(/Clashes with the existing branch feature\/inbox/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Use the existing/ })).toBeNull();
  });

  it("an existing branch another session uses is not offered", async () => {
    setup([{ sessionId: "other", branchName: "develop", worktreePath: "/x/wt", isMainWorktree: false }]);
    const { field } = await openNewTab();
    fireEvent.change(field, { target: { value: "DEVELOP" } });
    expect(await screen.findByText(/Branch develop already exists/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Use the existing/ })).toBeNull();
  });
});

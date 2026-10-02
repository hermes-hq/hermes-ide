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
import { findBranchClash, gitErrorMessage, parseBranchClashError } from "../utils/branchClash";
import { BranchConflictDialog, suggestNewBranchName } from "../components/BranchConflictDialog";
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

  it("a slow availability answer for an earlier name does not clear the clash error", async () => {
    setup();
    let answer: (v: { available: boolean; usedBySession: null }) => void = () => {};
    vi.mocked(checkBranchAvailable).mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    const { field } = await openNewTab();
    fireEvent.change(field, { target: { value: "fix/slow" } });
    await waitFor(() => expect(checkBranchAvailable).toHaveBeenCalledWith("p1", "fix/slow"));
    fireEvent.change(field, { target: { value: "Develop" } });
    expect(await screen.findByText(/Branch develop already exists/)).toBeInTheDocument();
    answer({ available: true, usedBySession: null });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText(/Branch develop already exists/)).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
  });

  it("an existing branch another session uses is not offered", async () => {
    setup([{ sessionId: "other", branchName: "develop", worktreePath: "/x/wt", isMainWorktree: false }]);
    const { field } = await openNewTab();
    fireEvent.change(field, { target: { value: "DEVELOP" } });
    expect(await screen.findByText(/Branch develop already exists/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Use the existing/ })).toBeNull();
  });
});

describe("the backend's BRANCH_NAME_CLASH error", () => {
  it("is read back into the name and the clash, and said in words", () => {
    const raw = 'BRANCH_NAME_CLASH:{"name":"Develop","existing":"develop","kind":"case"}';
    expect(parseBranchClashError(raw)).toEqual({ name: "Develop", clash: { kind: "case", existing: "develop" } });
    expect(parseBranchClashError(new Error(raw))).toEqual({ name: "Develop", clash: { kind: "case", existing: "develop" } });
    expect(gitErrorMessage(raw)).toMatch(/^Branch develop already exists: .*letter case/);
    expect(gitErrorMessage('BRANCH_NAME_CLASH:{"name":"develop","existing":"develop","kind":"same"}')).toBe("A branch named develop already exists");
    expect(gitErrorMessage('BRANCH_NAME_CLASH:{"name":"Feature/x","existing":"feature/inbox","kind":"folder"}')).toMatch(/^Clashes with the existing branch feature\/inbox/);
  });

  it("any other error is left as it is", () => {
    expect(parseBranchClashError("git worktree add failed: boom")).toBeNull();
    expect(parseBranchClashError("BRANCH_NAME_CLASH:not json")).toBeNull();
    expect(gitErrorMessage(new Error("disk full"))).toBe("disk full");
    expect(gitErrorMessage("BRANCH_NAME_CLASH:not json")).toBe("BRANCH_NAME_CLASH:not json");
  });
});

describe("Branch In Use choice: the new name is checked against every local branch", () => {
  const local = ["main", "develop", "feature/inbox", "main-2"];
  function renderDialog() {
    const onCreateNewBranch = vi.fn();
    const onUseExisting = vi.fn();
    render(
      <BranchConflictDialog
        branchName="main"
        heldBy="the project folder"
        path="/tmp/hermes-test/repo"
        localBranches={local}
        onReuse={vi.fn()}
        onCreateNewBranch={onCreateNewBranch}
        onUseExisting={onUseExisting}
        onCancel={vi.fn()}
      />,
    );
    const field = screen.getByRole("textbox", { name: "New branch name" }) as HTMLInputElement;
    return { field, onCreateNewBranch, onUseExisting };
  }

  it("offers a name no branch has (main-2 exists, so main-3)", () => {
    const { field } = renderDialog();
    expect(field.value).toBe("main-3");
    expect(suggestNewBranchName("main", ["main"])).toBe("main-2");
    expect(suggestNewBranchName("main", ["main", "Main-2"])).toBe("main-3");
  });

  it("an existing, free branch typed as the new name is refused, and offered on purpose", () => {
    const { field, onCreateNewBranch, onUseExisting } = renderDialog();
    fireEvent.change(field, { target: { value: "develop" } });
    expect(screen.getByRole("alert")).toHaveTextContent("A branch named develop already exists");
    fireEvent.click(screen.getByRole("button", { name: "Use new branch" }));
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onCreateNewBranch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use the existing develop" }));
    expect(onUseExisting).toHaveBeenCalledWith("develop");
  });

  it("letter case alone does not make it new; a folder in another case has nothing to offer", () => {
    const { field, onCreateNewBranch, onUseExisting } = renderDialog();
    fireEvent.change(field, { target: { value: "DEVELOP" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/Branch develop already exists/);
    fireEvent.click(screen.getByRole("button", { name: "Use the existing develop" }));
    expect(onUseExisting).toHaveBeenCalledWith("develop");
    fireEvent.change(field, { target: { value: "Feature/new" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/feature\/inbox/);
    expect(screen.queryByRole("button", { name: /Use the existing/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use new branch" }));
    expect(onCreateNewBranch).not.toHaveBeenCalled();
  });

  it("a free name is created as before", () => {
    const { field, onCreateNewBranch } = renderDialog();
    fireEvent.change(field, { target: { value: "fix/login" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use new branch" }));
    expect(onCreateNewBranch).toHaveBeenCalledWith("fix/login");
  });
});

/**
 * XP-10: the frontend recognises Hermes worktrees whatever the separator.
 * On Windows the backend hands over paths like
 * C:\Users\test\AppData\Roaming\com.hermes-ide.terminal\hermes-worktrees\ab12cd\s1_feature-login;
 * before the fix every check looked for "hermes-worktrees/" only.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { friendlyWorktreeLabel, isAnyHermesWorktreePath, isHermesWorktreePath, lastPathSegment, toForwardSlashes } from "../utils/worktree";
import { isWorktreePath } from "../api/projects";

const win = String.raw`C:\Users\test\AppData\Roaming\com.hermes-ide.terminal\hermes-worktrees\ab12cd\s1_feature-login`;
const winLegacy = String.raw`D:\code\my app\.hermes\worktrees\s1_fix`;
const posix = "/var/lib/demo/.local/share/com.hermes-ide.terminal/hermes-worktrees/ab12cd/s1_feature-login";
const project = String.raw`C:\Users\test\code\demo-app`;

describe("worktree paths on every OS", () => {
  it("one helper normalises the separators", () => {
    expect(toForwardSlashes(String.raw`a\b\c`)).toBe("a/b/c");
    expect(lastPathSegment(win)).toBe("s1_feature-login");
    expect(lastPathSegment(`${posix}/`)).toBe("s1_feature-login");
  });

  it("utils/worktree recognises a Windows worktree path", () => {
    expect(isHermesWorktreePath(posix)).toBe(true);
    expect(isHermesWorktreePath(win)).toBe(true);
    expect(isHermesWorktreePath(project)).toBe(false);
    expect(isAnyHermesWorktreePath(winLegacy)).toBe(true);
  });

  it("api/projects filters Windows worktrees out of the project list", () => {
    expect(isWorktreePath(win)).toBe(true);
    expect(isWorktreePath(winLegacy)).toBe(true);
    expect(isWorktreePath(posix)).toBe(true);
    expect(isWorktreePath(project)).toBe(false);
  });

  it("the Git panel names a Windows worktree by its branch", () => {
    expect(friendlyWorktreeLabel("demo-app", win)).toBe("demo-app (feature-login)");
    expect(friendlyWorktreeLabel("demo-app", posix)).toBe("demo-app (feature-login)");
    expect(friendlyWorktreeLabel("demo-app", project)).toBe("demo-app");
  });
});

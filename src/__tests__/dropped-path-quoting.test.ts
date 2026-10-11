/**
 * A file dropped on a shell session is typed as one literal argument: no
 * globbing (`[slug]`), no unmatched quote (`it's`), no `$VAR` expansion.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { quoteDroppedPath } from "../utils/fileDropTarget";

const POSIX_PATHS = [
  "/repo/app/[slug]/page.tsx",
  "/repo/it's.md",
  "/repo/cost$HOME.txt",
  "/repo/a `b` c.txt",
  "/repo/My Documents/notes.txt",
  "/repo/semi;colon & amp.txt",
];

describe("quoteDroppedPath", () => {
  it("leaves a plain path as it is", () => {
    expect(quoteDroppedPath("/Users/me/repo/src/main.rs")).toBe("/Users/me/repo/src/main.rs");
  });

  it("quotes a route folder zsh would glob", () => {
    expect(quoteDroppedPath("/repo/app/[slug]/page.tsx")).toBe("'/repo/app/[slug]/page.tsx'");
  });

  it.skipIf(process.platform === "win32").each(POSIX_PATHS)("the shell reads %s back unchanged", (path) => {
    const typed = quoteDroppedPath(path);
    expect(execFileSync("sh", ["-c", `printf '%s' ${typed}`], { encoding: "utf-8" })).toBe(path);
  });

  it("keeps double quotes for a Windows path with a space", () => {
    expect(quoteDroppedPath("C:\\Users\\me\\My Docs\\a.txt")).toBe('"C:\\Users\\me\\My Docs\\a.txt"');
    expect(quoteDroppedPath("C:\\Users\\me\\a.txt")).toBe("C:\\Users\\me\\a.txt");
  });
});

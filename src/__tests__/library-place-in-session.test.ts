/**
 * "Use in session" never sends: a terminal gets one bracketed paste with no
 * Enter, the Agent view gets the text in its message box (appended), and a
 * program that did not ask for bracketed paste gets multi-line text on the
 * clipboard instead of running it line by line.
 */
import { describe, expect, it, vi } from "vitest";
import { pasteBytes, placeInSession, type PlaceDeps } from "../library/placeInSession";

function deps(bracketed: boolean | null) {
  const writes: string[] = [];
  const drafts: [string, string][] = [];
  const copies: string[] = [];
  const d: PlaceDeps = {
    setDraft: (id, draft) => drafts.push([id, draft]),
    write: vi.fn(async (_id: string, b64: string) => {
      writes.push(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
    }),
    bracketed: () => bracketed,
    copy: async (t) => {
      copies.push(t);
    },
  };
  return { d, writes, drafts, copies };
}

describe("placeInSession", () => {
  it("pastes into a terminal as one bracketed paste and presses no Enter", async () => {
    const { d, writes } = deps(true);
    expect(await placeInSession({ id: "s1", mode: "terminal" }, "Review the diff.\nBe brief.", d)).toBe("pasted");
    expect(writes).toEqual(["\x1b[200~Review the diff.\nBe brief.\x1b[201~"]);
    expect(writes[0].endsWith("\r")).toBe(false);
    expect(writes[0].endsWith("\n")).toBe(false);
  });

  it("never lets the text end its own paste early", () => {
    expect(pasteBytes("a\x1b[201~b")).toBe("\x1b[200~ab\x1b[201~");
  });

  it("puts the text in an Agent-view draft, keeping what is there", async () => {
    const { d, drafts, writes } = deps(null);
    expect(await placeInSession({ id: "a1", mode: "agent", draft: "my notes" }, "Do X", d)).toBe("draft");
    expect(drafts).toEqual([["a1", "my notes\n\nDo X"]]);
    expect(writes).toEqual([]);
  });

  it("copies multi-line text when the program would run each line", async () => {
    const { d, writes, copies } = deps(false);
    expect(await placeInSession({ id: "s1", mode: "terminal" }, "line one\nline two", d)).toBe("copied");
    expect(writes).toEqual([]);
    expect(copies).toEqual(["line one\nline two"]);
    // One line is safe to type there.
    expect(await placeInSession({ id: "s1", mode: "terminal" }, "just this", d)).toBe("pasted");
  });

  it("does nothing with empty text", async () => {
    const { d, writes } = deps(true);
    expect(await placeInSession({ id: "s1", mode: "terminal" }, "  \n ", d)).toBe("empty");
    expect(writes).toEqual([]);
  });

  it("types a short lead line before a long paste, outside the paste brackets, still without Enter", async () => {
    const { d, writes } = deps(true);
    const long = "Step one.\nStep two.\nStep three.\nStep four.";
    expect(await placeInSession({ id: "s1", mode: "terminal" }, long, d, { lead: "Add a test:\nfollow the pasted prompt." })).toBe("pasted");
    expect(writes).toEqual([`Add a test: follow the pasted prompt. \x1b[200~${long}\x1b[201~`]);
  });

  it("presses Enter only when asked to send, after the paste", async () => {
    const { d, writes } = deps(true);
    const waited: number[] = [];
    d.wait = async (ms) => {
      waited.push(ms);
    };
    expect(await placeInSession({ id: "s1", mode: "terminal" }, "Ship it.", d, { send: true })).toBe("sent");
    expect(writes).toEqual(["\x1b[200~Ship it.\x1b[201~", "\r"]);
    expect(waited.length).toBe(1);
  });

  it("never sends or types a lead line into an Agent-view draft", async () => {
    const { d, drafts, writes } = deps(null);
    expect(await placeInSession({ id: "a1", mode: "agent" }, "Do X", d, { lead: "Lead", send: true })).toBe("draft");
    expect(drafts).toEqual([["a1", "Do X"]]);
    expect(writes).toEqual([]);
  });
});

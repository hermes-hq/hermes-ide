// @vitest-environment jsdom
/**
 * The file editor never changes a file the user did not edit, and never
 * writes over changes made on disk since it loaded:
 * - a CRLF file keeps its line endings (opening it wrote it back as LF)
 * - a save is refused when an agent changed the file meanwhile
 * - a file that is not UTF-8 opens read-only
 * - Alt+Up/Down in the editor does not also switch panes (Windows/Linux)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, screen, fireEvent, act } from "@testing-library/react";
import { EditorView } from "@codemirror/view";

let disk = "";
let diskReadOnly = false;
const writeFileContent = vi.fn(async (_s: string, _p: string, _f: string, content: string, expected: string | null) => {
  // Same rule as the backend's write_file_content.
  if (expected != null && expected !== disk) throw "FILE_CHANGED_ON_DISK";
  disk = content;
  return 2;
});

vi.mock("../api/git", () => ({
  readFileContent: vi.fn(async () => ({ content: disk, file_name: "a.rs", language: "plaintext", is_binary: false, size: disk.length, mtime: 1, read_only: diskReadOnly })),
  writeFileContent: (...a: [string, string, string, string, string | null]) => writeFileContent(...a),
  FILE_CHANGED_ON_DISK: "FILE_CHANGED_ON_DISK",
  sshReadFile: vi.fn(),
  sshWriteFile: vi.fn(),
  openFileInEditor: vi.fn(),
}));
vi.mock("../api/sessions", () => ({ writeToSession: vi.fn() }));
vi.mock("../api/settings", () => ({ getSetting: vi.fn(async () => ""), setSetting: vi.fn(async () => {}) }));
vi.mock("../state/SessionContext", () => ({ useSession: () => ({ state: { sessions: {} } }) }));

// jsdom has no layout; CodeMirror measures with ranges.
(document as unknown as { createRange: () => unknown }).createRange = () => ({
  setStart() {},
  setEnd() {},
  getBoundingClientRect() { return { left: 0, right: 0, top: 0, bottom: 0 }; },
  getClientRects() { return []; },
});

const editorView = () => EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
const tick = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

async function openPreview() {
  const { FilePreviewPanel } = await import("../components/FilePreviewPanel");
  render(<FilePreviewPanel sessionId="s" projectId="p" filePath="a.rs" onBack={() => {}} />);
  await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull(), { timeout: 5000 });
}

beforeEach(() => {
  document.body.innerHTML = "";
  writeFileContent.mockClear();
  diskReadOnly = false;
});

describe("CRLF files keep their line endings", () => {
  it("opening a CRLF file reports no edit, and an edit keeps CRLF", async () => {
    const { EditorPane } = await import("../editor/EditorPane");
    const onContentChange = vi.fn();
    render(<EditorPane content={"line one\r\nline two\r\n"} language="plaintext" onContentChange={onContentChange} onSave={() => {}} />);
    await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());
    await tick(50);
    expect(onContentChange).not.toHaveBeenCalled();

    act(() => editorView().dispatch({ changes: { from: 0, insert: "x" } }));
    expect(onContentChange).toHaveBeenLastCalledWith("xline one\r\nline two\r\n");
  });

  it("a CRLF file opened in the preview is not dirty and not saved", async () => {
    disk = "line one\r\nline two\r\n";
    await openPreview();
    await tick(100);
    expect(document.querySelector(".file-editor-dirty-dot")).toBeNull();
    expect((screen.getByText("Save").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(writeFileContent).not.toHaveBeenCalled();
  });
});

describe("a save never writes over changes made on disk", () => {
  async function editAfterAgentChange() {
    disk = "fn a() {}\n";
    await openPreview();
    disk = "fn a() {}\nfn agent_added() {}\n"; // an agent edits the open file
    act(() => editorView().dispatch({ changes: { from: 0, insert: "// note\n" } }));
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  }

  it("refuses the save and offers Reload, which shows the agent's version", async () => {
    await editAfterAgentChange();
    expect(disk).toBe("fn a() {}\nfn agent_added() {}\n");

    fireEvent.click(screen.getByText("Reload"));
    await waitFor(() => expect(editorView().state.doc.toString()).toBe("fn a() {}\nfn agent_added() {}\n"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Overwrite saves the user's edits over the disk", async () => {
    await editAfterAgentChange();
    fireEvent.click(screen.getByText("Overwrite"));
    await waitFor(() => expect(disk).toBe("// note\nfn a() {}\n"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("a file that is not UTF-8 opens read-only", () => {
  it("shows the text without an editor", async () => {
    disk = "caf� = 1\n";
    diskReadOnly = true;
    const { FilePreviewPanel } = await import("../components/FilePreviewPanel");
    render(<FilePreviewPanel sessionId="s" projectId="p" filePath="a.rs" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText("Read-only")).toBeTruthy());
    await tick(50);
    expect(document.querySelector(".cm-content")).toBeNull();
    expect(screen.queryByText("Save")).toBeNull();
    expect(document.querySelector(".file-preview-lines")?.textContent).toContain("caf");
  });
});

describe("Alt+Up/Down in the editor does not switch panes", () => {
  it("the editor marks the key handled, and pane navigation skips handled keys", async () => {
    const { EditorPane } = await import("../editor/EditorPane");
    const { matchAppShortcut } = await import("../utils/shortcuts");
    render(<EditorPane content={"a\nb\nc"} language="plaintext" onContentChange={() => {}} onSave={() => {}} />);
    await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());
    const seen: Array<{ action: string | null; handled: boolean }> = [];
    const listener = (e: KeyboardEvent) => seen.push({ action: matchAppShortcut(e, false), handled: e.defaultPrevented });
    window.addEventListener("keydown", listener);
    document.querySelector(".cm-content")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, altKey: true, bubbles: true, cancelable: true }),
    );
    window.removeEventListener("keydown", listener);
    expect(seen).toEqual([{ action: "app.focus-next-pane", handled: true }]);

  });
});

// ─── Unified diff → files, hunks, lines ───────────────────────────────
//
// Pure. The Review Desk renders from this and anchors line comments on the
// numbers it computes; the risk flags read the same structure.

export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** Line number in the old file; null for an added line. */
  readonly oldNo: number | null;
  /** Line number in the new file; null for a deleted line. */
  readonly newNo: number | null;
  /** The text without its leading marker. */
  readonly text: string;
}

export interface DiffHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: readonly DiffLine[];
}

export type ParsedFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface ParsedFile {
  readonly path: string;
  readonly oldPath: string | null;
  readonly status: ParsedFileStatus;
  readonly isBinary: boolean;
  readonly executable: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly DiffHunk[];
  /** This file's slice of the patch text, header included. */
  readonly raw: string;
}

function unquote(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return t;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function parseHunks(lines: readonly string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: { header: string; oldStart: number; newStart: number; lines: DiffLine[] } | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of lines) {
    const m = HUNK_RE.exec(line);
    if (m) {
      if (current) hunks.push(current);
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      current = { header: line, oldStart: oldNo, newStart: newNo, lines: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) {
      current.lines.push({ kind: "add", oldNo: null, newNo, text: line.slice(1) });
      newNo++;
    } else if (line.startsWith("-")) {
      current.lines.push({ kind: "del", oldNo, newNo: null, text: line.slice(1) });
      oldNo++;
    } else {
      current.lines.push({ kind: "context", oldNo, newNo, text: line.startsWith(" ") ? line.slice(1) : line });
      oldNo++;
      newNo++;
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

/** Split a unified diff (git's format) into files. Empty for empty text. */
export function parsePatch(text: string): ParsedFile[] {
  const out: ParsedFile[] = [];
  if (!text) return out;
  const lines = text.split("\n");
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (l.startsWith("diff --git ")) starts.push(i);
  });
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s];
    const to = s + 1 < starts.length ? starts[s + 1] : lines.length;
    const chunk = lines.slice(from, to);
    const header = chunk[0];
    let path: string | null = null;
    let oldPath: string | null = null;
    let status: ParsedFileStatus = "modified";
    let isBinary = false;
    let executable = false;
    let hunkAt = chunk.length;
    for (let i = 1; i < chunk.length; i++) {
      const line = chunk[i];
      if (line.startsWith("@@")) {
        hunkAt = i;
        break;
      }
      if (line.startsWith("new file mode ")) {
        status = "added";
        executable = line.slice("new file mode ".length).trim() === "100755";
      } else if (line.startsWith("deleted file mode ")) {
        status = "deleted";
      } else if (line.startsWith("new mode ")) {
        executable = line.slice("new mode ".length).trim() === "100755";
      } else if (line.startsWith("rename from ")) {
        status = "renamed";
        oldPath = unquote(line.slice("rename from ".length));
      } else if (line.startsWith("rename to ")) {
        path = unquote(line.slice("rename to ".length));
      } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        isBinary = true;
      } else if (line.startsWith("+++ ")) {
        const p = unquote(line.slice(4));
        if (p !== "/dev/null") path = p.startsWith("b/") ? p.slice(2) : p;
      } else if (line.startsWith("--- ")) {
        const p = unquote(line.slice(4));
        if (p !== "/dev/null") {
          const stripped = p.startsWith("a/") ? p.slice(2) : p;
          if (path === null || status === "deleted") path = stripped;
        }
      }
    }
    if (path === null) {
      const rest = header.slice("diff --git ".length);
      const at = rest.lastIndexOf(" b/");
      path = unquote(at >= 0 ? rest.slice(at + 3) : rest);
    }
    const hunks = parseHunks(chunk.slice(hunkAt));
    let additions = 0;
    let deletions = 0;
    for (const h of hunks) {
      for (const l of h.lines) {
        if (l.kind === "add") additions++;
        else if (l.kind === "del") deletions++;
      }
    }
    // Keep the trailing newline of every line but the last of the whole text.
    const rawLines = chunk.slice();
    const raw = rawLines.join("\n") + (to < lines.length || text.endsWith("\n") ? "\n" : "");
    out.push({ path, oldPath, status, isBinary, executable, additions, deletions, hunks, raw: raw.replace(/\n\n$/, "\n") });
  }
  return out;
}

/** The added lines of a file, for the risk scanners. */
export function addedText(file: ParsedFile): string {
  const parts: string[] = [];
  for (const h of file.hunks) for (const l of h.lines) if (l.kind === "add") parts.push(l.text);
  return parts.join("\n");
}

// ─── Review comments, the review file and the tagged line ─────────────
//
// Pure. A comment sits on one line of one file and belongs to the turn
// (and so the session, the agent) that changed it. When the person sends
// a turn's comments, they become `review-<n>.md` and ONE visible line the
// person pastes; the tag in that line is the delivery receipt.

export interface ReviewComment {
  readonly id: string;
  /** The session whose turn changed the line: where the comment goes. */
  readonly sessionId: string;
  /** The turn the line belongs to, or null when only the file is known. */
  readonly turnN: number | null;
  readonly path: string;
  /** "new" for a line in the changed file, "old" for a deleted line. */
  readonly side: "new" | "old";
  readonly line: number;
  /** The line's text at the time of the comment, for the review file. */
  readonly excerpt: string;
  readonly text: string;
  readonly createdAt: number;
}

/** The marker a person pastes; the agent's prompt event brings it back. */
export function reviewTag(n: number): string {
  return `[hermes-review #${n}]`;
}

/** The same marker as it appears in a SessionEvent's `tags`. */
export function reviewTagId(n: number): string {
  return `hermes-review#${n}`;
}

/** The one line pasted into the agent's terminal when the person presses Send. */
export function pasteLine(n: number, filePath: string): string {
  return `${reviewTag(n)} Please read the review comments in ${filePath} and address each one.`;
}

export interface ReviewFileInput {
  readonly n: number;
  readonly agentLabel: string;
  readonly repoPath: string;
  readonly branch: string | null;
  readonly comments: readonly ReviewComment[];
}

/** The Markdown a terminal agent reads. Grouped by file, lines in order. */
export function reviewMarkdown(input: ReviewFileInput): string {
  const byPath = new Map<string, ReviewComment[]>();
  for (const c of input.comments) {
    const list = byPath.get(c.path) ?? [];
    list.push(c);
    byPath.set(c.path, list);
  }
  const lines: string[] = [];
  lines.push(`# Review ${input.n} for ${input.agentLabel}`);
  lines.push("");
  lines.push(`Repository: ${input.repoPath}`);
  if (input.branch) lines.push(`Branch: ${input.branch}`);
  lines.push(`Comments: ${input.comments.length}`);
  lines.push("");
  lines.push("Address each comment below, then continue. Line numbers refer to the file as it is now (\"old\" lines to the version before your change).");
  lines.push("");
  for (const [path, comments] of byPath) {
    lines.push(`## ${path}`);
    lines.push("");
    for (const c of [...comments].sort((a, b) => a.line - b.line)) {
      const where = c.side === "old" ? `old line ${c.line}` : `line ${c.line}`;
      const turn = c.turnN !== null ? ` (turn ${c.turnN})` : "";
      lines.push(`- **${where}**${turn}: \`${c.excerpt.replace(/`/g, "'").slice(0, 160)}\``);
      for (const l of c.text.split("\n")) lines.push(`  ${l}`);
      lines.push("");
    }
  }
  lines.push(`_${reviewTag(input.n)}_`);
  lines.push("");
  return lines.join("\n");
}

/** Comments that belong to one session (the agent that owns the turn). */
export function commentsForSession(comments: readonly ReviewComment[], sessionId: string): ReviewComment[] {
  return comments.filter((c) => c.sessionId === sessionId);
}

/** The bracketed-paste bytes for the one visible line, base64 as the PTY write takes it. */
export function encodePaste(line: string): string {
  const payload = "\x1b[200~" + line + "\x1b[201~" + "\r";
  const bytes = new TextEncoder().encode(payload);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

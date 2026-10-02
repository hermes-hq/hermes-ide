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
  /** Up to two lines above and below it (same side), to find it again. */
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  readonly text: string;
  readonly createdAt: number;
}

/** One line of a file's diff as the desk shows it. */
export interface AnchorLine {
  readonly side: "new" | "old";
  /** Its number on that side (null: none). */
  readonly no: number | null;
  readonly text: string;
}

/** Lines of context kept around a commented line. */
export const ANCHOR_CONTEXT = 2;

/** The context of line `index` among `lines` of one side: what a comment keeps. */
export function anchorContext(lines: readonly AnchorLine[], index: number): { before: string[]; after: string[] } {
  const side = lines[index]?.side;
  const same = lines.map((l, i) => ({ l, i })).filter((x) => x.l.side === side);
  const at = same.findIndex((x) => x.i === index);
  if (at < 0) return { before: [], after: [] };
  return {
    before: same.slice(Math.max(0, at - ANCHOR_CONTEXT), at).map((x) => x.l.text),
    after: same.slice(at + 1, at + 1 + ANCHOR_CONTEXT).map((x) => x.l.text),
  };
}

/**
 * Where a comment sits in a file's diff now: the line (on its side) with
 * the comment's text whose surroundings match best, nearest to where it was
 * on a tie. Line numbers move when the next turn inserts lines above; the
 * text and its context do not. Null when the line is gone (outdated).
 */
export function relocateComment(c: Pick<ReviewComment, "side" | "line" | "excerpt" | "before" | "after">, lines: readonly AnchorLine[]): number | null {
  const same = lines.filter((l) => l.side === c.side && l.no !== null);
  let best: { no: number; score: number; distance: number } | null = null;
  for (let i = 0; i < same.length; i++) {
    if (same[i].text !== c.excerpt) continue;
    let score = 0;
    const before = c.before ?? [];
    const after = c.after ?? [];
    for (let k = 1; k <= before.length; k++) if (same[i - k]?.text === before[before.length - k]) score++;
    for (let k = 0; k < after.length; k++) if (same[i + 1 + k]?.text === after[k]) score++;
    const no = same[i].no as number;
    const distance = Math.abs(no - c.line);
    if (!best || score > best.score || (score === best.score && distance < best.distance)) best = { no, score, distance };
  }
  return best?.no ?? null;
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

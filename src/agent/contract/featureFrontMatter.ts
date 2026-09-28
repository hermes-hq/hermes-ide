// ─── .hermes/features/<slug>/feature.md front matter ──────────────────
//
// Contract C0 (docs/adr/004-2.0-contracts.md). F28 fills the behaviour
// (the watcher, gates, phases, the hi helper). This is the typed reader of
// the front matter at the top of feature.md:
//
//   ---
//   slug: search-index
//   track: Full            # Quick | Light | Full
//   phase: plan            # questions | research | design | structure | plan | implement | done
//   gate: waiting          # none | waiting | approved
//   done_when:
//     - npm test
//     - npm run lint
//   ---
//   <the feature's description, free markdown>
//
// The reader understands `key: scalar`, `key: [a, b]` and `key:` followed by
// `- item` lines. Any other line is an error with its 1-based line number,
// which F28 shows as "feature.md can't be read (line n)". Unknown keys are
// kept in `ignored` so an older Hermes keeps reading a newer file.

export const FEATURE_TRACKS = ["Quick", "Light", "Full"] as const;
export type FeatureTrack = (typeof FEATURE_TRACKS)[number];

export const FEATURE_PHASES = ["questions", "research", "design", "structure", "plan", "implement", "done"] as const;
export type FeaturePhase = (typeof FEATURE_PHASES)[number];

export const FEATURE_GATES = ["none", "waiting", "approved"] as const;
export type FeatureGate = (typeof FEATURE_GATES)[number];

export interface FeatureMeta {
  readonly slug: string;
  readonly track: FeatureTrack;
  readonly phase: FeaturePhase;
  readonly gate: FeatureGate;
  readonly doneWhen: readonly string[];
  /** Keys this Hermes does not know. */
  readonly ignored: readonly string[];
}

export type FeatureFrontMatterResult =
  | { readonly ok: true; readonly meta: FeatureMeta; readonly body: string }
  | { readonly ok: false; readonly error: string; readonly line: number };

/** A slug is a branch component: hermes/<slug>. */
export function isFeatureSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

class FrontMatterError extends Error {
  constructor(
    message: string,
    public readonly line: number,
  ) {
    super(message);
  }
}

function unquote(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function stripComment(text: string): string {
  let inString: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === inString) inString = null;
    } else if (c === '"' || c === "'") inString = c;
    else if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
  }
  return text;
}

type Scalar = string;
type Value = Scalar | string[];

function parseInlineList(raw: string, line: number): string[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((p) => {
    const v = unquote(p);
    if (v === "") throw new FrontMatterError("empty list item", line);
    return v;
  });
}

/** Parse the lines between the --- fences (1-based line numbers of the file). */
function parseBlock(lines: readonly string[], firstLineNo: number): Map<string, { value: Value; line: number }> {
  const out = new Map<string, { value: Value; line: number }>();
  let pendingList: { key: string; items: string[]; line: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const lineNo = firstLineNo + i;
    const line = stripComment(lines[i]).replace(/\s+$/, "");
    if (line.trim() === "") continue;
    const item = /^\s+-\s*(.*)$/.exec(line) ?? /^-\s*(.*)$/.exec(line);
    if (item) {
      if (!pendingList) throw new FrontMatterError("list item outside a list", lineNo);
      const v = unquote(item[1]);
      if (v === "") throw new FrontMatterError("empty list item", lineNo);
      pendingList.items.push(v);
      continue;
    }
    if (/^\s/.test(line)) throw new FrontMatterError("unexpected indentation", lineNo);
    pendingList = null;
    const kv = /^([A-Za-z0-9_-]+):(?:\s+(.*)|)$/.exec(line);
    if (!kv) throw new FrontMatterError("expected key: value", lineNo);
    const key = kv[1];
    if (out.has(key)) throw new FrontMatterError(`${key} given twice`, lineNo);
    const raw = (kv[2] ?? "").trim();
    if (raw === "") {
      pendingList = { key, items: [], line: lineNo };
      out.set(key, { value: pendingList.items, line: lineNo });
    } else if (raw.startsWith("[")) {
      if (!raw.endsWith("]")) throw new FrontMatterError("unterminated list", lineNo);
      out.set(key, { value: parseInlineList(raw, lineNo), line: lineNo });
    } else {
      out.set(key, { value: unquote(raw), line: lineNo });
    }
  }
  return out;
}

const KNOWN_KEYS = new Set(["slug", "track", "phase", "gate", "done_when"]);

function oneOf<T extends string>(
  entry: { value: Value; line: number } | undefined,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (entry === undefined) return fallback;
  if (typeof entry.value !== "string") throw new FrontMatterError(`${key} must be one word`, entry.line);
  if (!(allowed as readonly string[]).includes(entry.value)) {
    throw new FrontMatterError(`${key} must be one of ${allowed.join(", ")}`, entry.line);
  }
  return entry.value as T;
}

/** Read feature.md. Never throws; errors carry the 1-based line. */
export function parseFeatureFrontMatter(text: string): FeatureFrontMatterResult {
  try {
    const lines = text.split(/\r?\n/);
    if (lines.length === 0 || lines[0].trim() !== "---") throw new FrontMatterError("feature.md must start with ---", 1);
    let close = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        close = i;
        break;
      }
    }
    if (close === -1) {
      let last = lines.length;
      while (last > 1 && lines[last - 1].trim() === "") last--;
      throw new FrontMatterError("front matter never closes (missing ---)", last);
    }
    const fields = parseBlock(lines.slice(1, close), 2);

    const ignored = [...fields.keys()].filter((k) => !KNOWN_KEYS.has(k));
    const slugEntry = fields.get("slug");
    if (!slugEntry) throw new FrontMatterError("slug is required", 1);
    if (typeof slugEntry.value !== "string" || !isFeatureSlug(slugEntry.value)) {
      throw new FrontMatterError("slug must be lowercase letters, digits and dashes", slugEntry.line);
    }
    const trackEntry = fields.get("track");
    if (!trackEntry) throw new FrontMatterError("track is required (Quick, Light or Full)", 1);
    const track = oneOf(trackEntry, "track", FEATURE_TRACKS, "Light");
    const phase = oneOf(fields.get("phase"), "phase", FEATURE_PHASES, "questions");
    const gate = oneOf(fields.get("gate"), "gate", FEATURE_GATES, "none");
    const dw = fields.get("done_when");
    let doneWhen: readonly string[] = Object.freeze([]);
    if (dw) {
      if (typeof dw.value === "string") throw new FrontMatterError("done_when must be a list", dw.line);
      doneWhen = Object.freeze([...dw.value]);
    }
    return {
      ok: true,
      meta: Object.freeze({ slug: slugEntry.value, track, phase, gate, doneWhen, ignored: Object.freeze(ignored) }),
      body: lines.slice(close + 1).join("\n"),
    };
  } catch (e) {
    if (e instanceof FrontMatterError) return { ok: false, error: e.message, line: e.line };
    return { ok: false, error: e instanceof Error ? e.message : String(e), line: 0 };
  }
}

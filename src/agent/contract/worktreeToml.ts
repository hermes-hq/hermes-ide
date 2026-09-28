// ─── .hermes/worktree.toml ────────────────────────────────────────────
//
// Contract C0 (docs/adr/004-2.0-contracts.md). F26 fills the behaviour
// (running setup, copying files, refusing tracked files). This is the
// typed reader of the file:
//
//   setup = ["npm ci", "cargo fetch"]   # run in the new worktree, in order
//   copy = [".env*"]                    # globs of git-ignored files to copy
//   done_when = ["npm test"]            # default checks (F27) when no feature.md
//
//   [ports]                             # named ports the worktree may use
//   web = 3000
//
// The reader understands the TOML subset the file needs: comments, bare
// keys, quoted strings, integers, booleans, arrays of those (single or
// multi-line) and one level of [table]. Anything else is an error with a
// line number, never a guess. Unknown keys are kept in `ignored` so an older
// Hermes keeps reading a newer file.

export interface WorktreeConfig {
  readonly setup: readonly string[];
  readonly copy: readonly string[];
  readonly doneWhen: readonly string[];
  readonly ports: Readonly<Record<string, number>>;
  /** Keys this Hermes does not know, as "key" or "table.key". */
  readonly ignored: readonly string[];
}

export const EMPTY_WORKTREE_CONFIG: WorktreeConfig = Object.freeze({
  setup: Object.freeze([]),
  copy: Object.freeze([]),
  doneWhen: Object.freeze([]),
  ports: Object.freeze({}),
  ignored: Object.freeze([]),
});

export type WorktreeTomlResult =
  | { readonly ok: true; readonly config: WorktreeConfig }
  | { readonly ok: false; readonly error: string; readonly line: number };

type TomlValue = string | number | boolean | TomlValue[];

class TomlError extends Error {
  constructor(
    message: string,
    public readonly line: number,
  ) {
    super(message);
  }
}

/** Strip a trailing comment that is not inside a string. */
function stripComment(text: string): string {
  let inString: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\" && inString === '"') i++;
      else if (c === inString) inString = null;
    } else if (c === '"' || c === "'") inString = c;
    else if (c === "#") return text.slice(0, i);
  }
  return text;
}

function parseString(raw: string, line: number): string {
  const q = raw[0];
  if (raw.length < 2 || raw[raw.length - 1] !== q) throw new TomlError("unterminated string", line);
  const body = raw.slice(1, -1);
  if (q === "'") return body;
  return body.replace(/\\(.)/g, (m, c: string) => {
    switch (c) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "\\":
        return "\\";
      case '"':
        return '"';
      default:
        throw new TomlError(`unknown escape ${m}`, line);
    }
  });
}

function parseScalar(raw: string, line: number): TomlValue {
  const t = raw.trim();
  if (t === "") throw new TomlError("missing value", line);
  if (t[0] === '"' || t[0] === "'") return parseString(t, line);
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^[+-]?\d[\d_]*$/.test(t)) return Number(t.replace(/_/g, ""));
  throw new TomlError(`cannot read value ${t}`, line);
}

/** Split the inside of [...] on commas outside strings and nested arrays. */
function splitArray(inner: string, line: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inString) {
      if (c === "\\" && inString === '"') i++;
      else if (c === inString) inString = null;
    } else if (c === '"' || c === "'") inString = c;
    else if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  if (inString) throw new TomlError("unterminated string", line);
  if (depth !== 0) throw new TomlError("unbalanced brackets", line);
  parts.push(inner.slice(start));
  return parts.map((p) => p.trim()).filter((p, i, arr) => !(p === "" && i === arr.length - 1));
}

function parseValue(raw: string, line: number): TomlValue {
  const t = raw.trim();
  if (t[0] === "[") {
    if (t[t.length - 1] !== "]") throw new TomlError("unterminated array", line);
    return splitArray(t.slice(1, -1), line).map((p) => {
      if (p === "") throw new TomlError("empty array element", line);
      return parseValue(p, line);
    });
  }
  return parseScalar(t, line);
}

/** key = value lines into a nested map: { key: value, table: { key: value } }. */
function parseToml(text: string): Map<string, TomlValue | Map<string, TomlValue>> {
  const root = new Map<string, TomlValue | Map<string, TomlValue>>();
  let current: Map<string, TomlValue> | null = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let line = stripComment(lines[i]).trim();
    if (line === "") continue;
    const table = /^\[([A-Za-z0-9_-]+)\]$/.exec(line);
    if (table) {
      if (root.has(table[1])) throw new TomlError(`table [${table[1]}] defined twice`, lineNo);
      current = new Map();
      root.set(table[1], current);
      continue;
    }
    if (line.startsWith("[")) throw new TomlError("only [name] tables are supported", lineNo);
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) throw new TomlError("expected key = value", lineNo);
    let raw = kv[2];
    // A multi-line array: keep reading until the brackets balance.
    if (raw.trimStart().startsWith("[")) {
      let depth = 0;
      const count = (s: string) => {
        let inString: '"' | "'" | null = null;
        for (let k = 0; k < s.length; k++) {
          const c = s[k];
          if (inString) {
            if (c === "\\" && inString === '"') k++;
            else if (c === inString) inString = null;
          } else if (c === '"' || c === "'") inString = c;
          else if (c === "[") depth++;
          else if (c === "]") depth--;
        }
      };
      count(raw);
      while (depth > 0 && i + 1 < lines.length) {
        i++;
        line = stripComment(lines[i]);
        raw += " " + line.trim();
        count(line);
      }
      if (depth > 0) throw new TomlError("unterminated array", lineNo);
    }
    const target = current ?? root;
    if (target.has(kv[1])) throw new TomlError(`key ${kv[1]} defined twice`, lineNo);
    target.set(kv[1], parseValue(raw, lineNo));
  }
  return root;
}

function stringList(value: TomlValue | Map<string, TomlValue> | undefined, key: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new TomlError(`${key} must be an array of strings`, 0);
  }
  return Object.freeze(value as string[]);
}

const KNOWN_KEYS = new Set(["setup", "copy", "done_when", "ports"]);

/** Read a worktree.toml. Never throws; errors carry the line (0: whole file). */
export function parseWorktreeToml(text: string): WorktreeTomlResult {
  try {
    const doc = parseToml(text);
    const ignored: string[] = [];
    for (const key of doc.keys()) if (!KNOWN_KEYS.has(key)) ignored.push(key);
    const rawPorts = doc.get("ports");
    const ports: Record<string, number> = {};
    if (rawPorts !== undefined) {
      if (!(rawPorts instanceof Map)) throw new TomlError("ports must be a [ports] table", 0);
      for (const [name, v] of rawPorts) {
        if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) {
          throw new TomlError(`ports.${name} must be a port number (1-65535)`, 0);
        }
        ports[name] = v;
      }
    }
    for (const key of ["setup", "copy", "done_when"]) {
      if (doc.get(key) instanceof Map) throw new TomlError(`${key} must be an array of strings`, 0);
    }
    return {
      ok: true,
      config: Object.freeze({
        setup: stringList(doc.get("setup"), "setup"),
        copy: stringList(doc.get("copy"), "copy"),
        doneWhen: stringList(doc.get("done_when"), "done_when"),
        ports: Object.freeze(ports),
        ignored: Object.freeze(ignored),
      }),
    };
  } catch (e) {
    if (e instanceof TomlError) return { ok: false, error: e.message, line: e.line };
    return { ok: false, error: e instanceof Error ? e.message : String(e), line: 0 };
  }
}

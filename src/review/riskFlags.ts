// ─── Deterministic risk flags ─────────────────────────────────────────
//
// A flag marks a change a person should look at twice, from the path and
// the added lines alone: no model, no network, the same answer every time.

import { addedText, type ParsedFile } from "./patch";

export type RiskFlagKind =
  | "lockfile"
  | "new_dependency"
  | "workflow"
  | "auth_crypto"
  | "secret"
  | "new_binary"
  | "postinstall"
  | "curl_pipe_sh"
  | "checks_changed"
  | "agent_config";

export interface RiskFlag {
  readonly kind: RiskFlagKind;
  /** A few words for the badge. */
  readonly label: string;
  /** One line saying what was seen. */
  readonly detail: string;
}

const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "composer.lock",
  "go.sum",
  "packages.lock.json",
  "flake.lock",
  "mix.lock",
  "pubspec.lock",
];

const MANIFESTS = ["package.json", "Cargo.toml", "pyproject.toml", "requirements.txt", "Gemfile", "go.mod", "composer.json", "Pipfile"];

const AUTH_CRYPTO_PATH = /(^|[\\/._-])(auth|authn|authz|oauth|oidc|sso|login|session|password|passwd|credential|crypto|cipher|encrypt|decrypt|jwt|token|secret|keychain|signing|permission|acl|rbac)([\\/._-]|$)/i;

const SECRET_PATTERNS: readonly { re: RegExp; what: string }[] = [
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, what: "a private key block" },
  { re: /\bsk-ant-[A-Za-z0-9_-]{8,}/, what: "an Anthropic API key" },
  { re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/, what: "an API key (sk-…)" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/, what: "a GitHub token" },
  // Built from pieces so the prefix itself never appears in the source (the repository's own secret scan would flag it).
  { re: new RegExp("\\bgithub_" + "pat_[A-Za-z0-9_]{20,}"), what: "a GitHub token" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: "an AWS access key id" },
  { re: /\bAIza[0-9A-Za-z_-]{30,}/, what: "a Google API key" },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, what: "a Slack token" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, what: "a JWT" },
  { re: /(?:^|[^A-Za-z0-9_])(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret)\s*[:=]\s*["'][^"'\s]{8,}["']/i, what: "a literal credential" },
];

const CURL_PIPE_SH = /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/;

/**
 * Files that steer an agent: its settings, permissions and hooks, its MCP
 * servers, its standing instructions. An agent that edits them changes what
 * it (or the next agent) may do without asking.
 */
const AGENT_CONFIG_PATH = /(^|\/)(\.claude\/|\.codex\/|\.agents\/|\.gemini\/)|(^|\/)(\.mcp\.json|AGENTS\.md|CLAUDE\.md|CLAUDE\.local\.md|GEMINI\.md)$/;

/** The two sides of a file's diff as far as the hunks show them. */
function sides(file: ParsedFile): { before: string[]; after: string[]; changed: { side: "old" | "new"; index: number }[] } {
  const before: string[] = [];
  const after: string[] = [];
  const changed: { side: "old" | "new"; index: number }[] = [];
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.kind !== "add") before.push(l.text);
      if (l.kind !== "del") after.push(l.text);
      if (l.kind === "del") changed.push({ side: "old", index: before.length - 1 });
      if (l.kind === "add") changed.push({ side: "new", index: after.length - 1 });
    }
  }
  return { before, after, changed };
}

/** The done_when commands in a fragment, and the lines that hold them; null when it has none. */
function doneWhenIn(lines: readonly string[], toml: boolean): { count: number; from: number; to: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const m = toml ? /^\s*done_when\s*=\s*(.*)$/.exec(lines[i]) : /^done_when:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const rest = m[1].replace(/\s+#.*$/, "").trim();
    if (rest.startsWith("[")) {
      // Inline (possibly over several lines in TOML).
      let text = rest;
      let j = i;
      while (!text.includes("]") && j + 1 < lines.length) text += lines[++j];
      const inner = text.slice(1, text.indexOf("]") >= 0 ? text.indexOf("]") : undefined);
      const items = toml ? inner.match(/"(?:[^"\\]|\\.)*"|'[^']*'/g) ?? [] : inner.split(",").filter((x) => x.trim() !== "");
      return { count: items.length, from: i, to: j };
    }
    if (rest === "" && !toml) {
      let j = i;
      while (j + 1 < lines.length && /^\s*-\s/.test(lines[j + 1])) j++;
      return { count: j - i, from: i, to: j };
    }
    return { count: 0, from: i, to: i };
  }
  return null;
}

function commands(n: number): string {
  return n === 1 ? "1 command" : `${n} commands`;
}

/** The checks-changed flag of worktree.toml or a feature.md, when its done_when moved. */
function checksFlag(file: ParsedFile, path: string, toml: boolean): RiskFlag | null {
  // A new file only adds checks; nothing that held the agent was taken away.
  if (file.status === "added") return null;
  const { before, after, changed } = sides(file);
  const was = doneWhenIn(before, toml);
  const now = doneWhenIn(after, toml);
  const inside = (region: { from: number; to: number } | null, side: "old" | "new") =>
    !!region && changed.some((c) => c.side === side && c.index >= region.from && c.index <= region.to);
  const touched = inside(was, "old") || inside(now, "new") || (was === null) !== (now === null) || (was !== null && now !== null && was.count !== now.count);
  if (!touched) return null;
  const a = was?.count ?? 0;
  const b = now?.count ?? 0;
  return {
    kind: "checks_changed",
    label: "checks changed",
    detail: a !== b ? `done_when went from ${commands(a)} to ${commands(b)} in ${path}` : `done_when changed in ${path}: the checks that gate Land`,
  };
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

function dependencyLines(file: ParsedFile): string[] {
  const name = basename(file.path);
  const added = addedText(file).split("\n");
  if (name === "package.json") {
    // "name": "^1.2.3" lines that look like a dependency entry.
    return added.filter((l) => /^\s*"[^"]+"\s*:\s*"[^"]*"\s*,?\s*$/.test(l) && !/^\s*"(name|version|description|main|module|types|license|author|private|type|homepage|repository|scripts|engines|browser|exports|files)"\s*:/.test(l));
  }
  if (name === "Cargo.toml" || name === "pyproject.toml") {
    return added.filter((l) => /^\s*[A-Za-z0-9_.-]+\s*=\s*(?:"[^"]*"|\{)/.test(l) && !/^\s*(name|version|edition|description|license|authors|readme|repository|homepage|rust-version|publish|build)\s*=/.test(l));
  }
  if (name === "requirements.txt" || name === "Pipfile") {
    return added.filter((l) => /^[A-Za-z0-9_.-]+\s*(?:[<>=!~]=?|$)/.test(l.trim()) && !l.trim().startsWith("#") && !l.trim().startsWith("-"));
  }
  if (name === "Gemfile") return added.filter((l) => /^\s*gem\s+["']/.test(l));
  if (name === "go.mod") return added.filter((l) => /^\s+[A-Za-z0-9./_-]+\s+v[0-9]/.test(l) || /^require\s+[A-Za-z0-9./_-]+\s+v[0-9]/.test(l));
  if (name === "composer.json") return added.filter((l) => /^\s*"[^"]+\/[^"]+"\s*:\s*"[^"]*"/.test(l));
  return [];
}

/** Every flag for one changed file, in a stable order. */
export function riskFlagsFor(file: ParsedFile): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const name = basename(file.path);
  const path = file.path.replace(/\\/g, "/");

  if (LOCKFILES.includes(name)) {
    flags.push({ kind: "lockfile", label: "lockfile", detail: `${name} changed: dependencies were resolved differently` });
  }
  if (MANIFESTS.includes(name)) {
    const deps = dependencyLines(file);
    if (deps.length > 0) {
      const first = deps[0].trim().replace(/,$/, "");
      flags.push({
        kind: "new_dependency",
        label: deps.length === 1 ? "new dependency" : `${deps.length} new dependencies`,
        detail: deps.length === 1 ? `adds ${first}` : `adds ${first} and ${deps.length - 1} more`,
      });
    }
    if (name === "package.json") {
      const scripts = addedText(file).match(/"(pre|post)install"\s*:\s*"([^"]*)"/);
      if (scripts) flags.push({ kind: "postinstall", label: `${scripts[1]}install script`, detail: `runs on install: ${scripts[2]}` });
    }
  }
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) || /^\.gitlab-ci\.ya?ml$/.test(path) || /^\.circleci\//.test(path) || /^\.buildkite\//.test(path)) {
    flags.push({ kind: "workflow", label: "CI workflow", detail: `${path} changed: it runs with the repository's secrets` });
  }
  if (path === ".hermes/worktree.toml" || path.endsWith("/.hermes/worktree.toml")) {
    flags.push(
      checksFlag(file, path, true) ?? {
        kind: "agent_config",
        label: "agent config",
        detail: `${path} changed: it sets what runs in every new worktree`,
      },
    );
  } else if (/(^|\/)\.hermes\/features\/[^/]+\/feature\.md$/.test(path)) {
    const flag = checksFlag(file, path, false);
    if (flag) flags.push(flag);
  }
  if (AGENT_CONFIG_PATH.test(path)) {
    flags.push({ kind: "agent_config", label: "agent config", detail: `${path} changed: it steers what an agent may do` });
  }
  if (AUTH_CRYPTO_PATH.test(path)) {
    flags.push({ kind: "auth_crypto", label: "auth / crypto", detail: `${path} is on an authentication or cryptography path` });
  }
  if (!file.isBinary) {
    const added = addedText(file);
    for (const { re, what } of SECRET_PATTERNS) {
      if (re.test(added)) {
        flags.push({ kind: "secret", label: "secret", detail: `an added line looks like ${what}` });
        break;
      }
    }
    if (CURL_PIPE_SH.test(added)) {
      flags.push({ kind: "curl_pipe_sh", label: "curl | sh", detail: "an added line downloads a script and runs it in one go" });
    }
  }
  if (file.isBinary && file.status === "added") {
    flags.push({ kind: "new_binary", label: "new binary", detail: `${path} is a new binary file` });
  }
  return flags;
}

/** All flags across files, with the file each belongs to. */
export function riskFlagsForFiles(files: readonly ParsedFile[]): { path: string; flag: RiskFlag }[] {
  const out: { path: string; flag: RiskFlag }[] = [];
  for (const f of files) for (const flag of riskFlagsFor(f)) out.push({ path: f.path, flag });
  return out;
}

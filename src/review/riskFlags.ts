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
  | "curl_pipe_sh";

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

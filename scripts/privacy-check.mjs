#!/usr/bin/env node
// Privacy check for pull requests (the `privacy` job in .github/workflows/ci.yml).
//
// This repository is public. The check fails when a change adds:
//   - a personal home path (/Users/<name>, /home/<name>, C:\Users\<name>)
//     whose <name> is not one of the synthetic names in the allowlist;
//   - an email address, unless it is synthetic (allowlisted domain or local
//     part), sits in an allowlisted file (LICENSE, CLA.md), or already
//     appears in the same file in the base tree (existing credits); an
//     address from README.md added to a new test fixture still fails;
//   - a new binary or data file (images, databases, archives, logs, .env,
//     recorded sessions, keys) outside the directories meant for them.
// Commit messages are checked for personal paths too.
//
// Secrets are covered by gitleaks in the same job.
//
// Usage: node scripts/privacy-check.mjs --base <ref> [--head <ref>]
// Allowlist: .github/privacy-allowlist.json

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Generated files that are not reviewed line by line. */
export const SKIPPED_FILES = ["package-lock.json", "src-tauri/Cargo.lock", "src-tauri/bridge/package-lock.json"];

const DATA_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "ico",
  "mp4", "mov", "webm", "mkv", "avi",
  "db", "sqlite", "sqlite3", "db-wal", "db-shm", "db-journal",
  "zip", "tar", "tgz", "gz", "bz2", "xz", "7z", "rar",
  "log", "cast", "har", "dmp",
  "pem", "key", "p8", "p12", "pfx",
]);

/** File extensions that look like email domains: `icon@2x.png`. */
const FILE_LIKE_TLDS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "js", "mjs", "ts", "tsx", "css", "json", "md"]);

// The slash before Users/home must not follow a word character, so a
// relative path through a folder named Users (inside `components`, say) is
// not a home path.
const UNIX_HOME = /(?<![\w.-])\/(?:Users|home)\/([A-Za-z][\w.-]*)/g;
const WINDOWS_HOME = /\b[A-Za-z]:(?:\\+|\/)Users(?:\\+|\/)([A-Za-z][\w.-]*)/g;
export const EMAIL = /(?<![\w.%+-])([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;

/**
 * Parse `git diff --unified=0` output into the lines it adds.
 * @param {string} diff
 * @returns {{ file: string, line: number, text: string }[]}
 */
export function parseAddedLines(diff) {
  const out = [];
  let file = null;
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4);
      file = target === "/dev/null" ? null : target.replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff --git")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (file && raw.startsWith("+")) {
      out.push({ file, line, text: raw.slice(1) });
      line += 1;
    }
  }
  return out;
}

/** @param {string} name @param {{ userNames: string[] }} allow */
function isSyntheticUser(name, allow) {
  const lower = name.toLowerCase();
  return allow.userNames.some((n) => n.toLowerCase() === lower);
}

/**
 * Personal home paths in a piece of text.
 * @returns {string[]} the offending paths
 */
export function findPersonalPaths(text, allow) {
  const hits = [];
  for (const re of [UNIX_HOME, WINDOWS_HOME]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (!isSyntheticUser(m[1], allow)) hits.push(m[0]);
    }
  }
  return hits;
}

/** @param {string} domain @param {string[]} patterns */
function domainAllowed(domain, patterns) {
  const d = domain.toLowerCase();
  return patterns.some((p) => {
    const q = p.toLowerCase();
    return q.startsWith("*.") ? d.endsWith(q.slice(1)) : d === q;
  });
}

/**
 * Email addresses in a line that are not allowed.
 * @param {string} text
 * @param {string} file
 * @param {object} allow
 * @param {Map<string, Set<string>>} existingEmails lower-cased address → files
 *   that already contain it in the base tree
 */
export function findEmails(text, file, allow, existingEmails) {
  if (allow.emailFiles.includes(file)) return [];
  const hits = [];
  EMAIL.lastIndex = 0;
  for (const m of text.matchAll(EMAIL)) {
    const [address, local, domain] = m;
    const tld = domain.split(".").pop().toLowerCase();
    if (FILE_LIKE_TLDS.has(tld)) continue;
    if (allow.emailLocalParts.includes(local.toLowerCase())) continue;
    if (domainAllowed(domain, allow.emailDomains)) continue;
    if (existingEmails.get(address.toLowerCase())?.has(file)) continue;
    hits.push(address);
  }
  return hits;
}

/**
 * Whether a newly added file is a binary or data file outside the places
 * meant for them.
 * @param {string} file
 * @param {boolean} isBinary git reports the file as binary
 */
export function isForbiddenNewFile(file, isBinary, allow) {
  if (allow.files.includes(file)) return false;
  if (allow.dataFileDirs.some((dir) => file.startsWith(dir))) return false;
  const base = file.split("/").pop();
  const lowerBase = base.toLowerCase();
  if (lowerBase === ".env" || lowerBase.startsWith(".env.") || lowerBase.endsWith(".env")) {
    return !/\.(example|sample|template)$/.test(lowerBase);
  }
  const dot = lowerBase.lastIndexOf(".");
  if (dot > 0 && DATA_EXTENSIONS.has(lowerBase.slice(dot + 1))) return true;
  return isBinary;
}

/**
 * Run every check on already-collected inputs.
 * @param {{
 *   added: { file: string, line: number, text: string }[],
 *   newFiles: { file: string, binary: boolean, from?: string }[],
 *   commitMessages: string[],
 *   existingEmails: Map<string, Set<string>>,
 *   allow: object,
 * }} input
 * @returns {{ file?: string, line?: number, message: string }[]}
 */
export function checkPrivacy({ added, newFiles, commitMessages, existingEmails, allow }) {
  const findings = [];
  for (const { file, line, text } of added) {
    if (SKIPPED_FILES.includes(file) || allow.files.includes(file)) continue;
    for (const p of findPersonalPaths(text, allow)) {
      findings.push({ file, line, message: `personal path "${p}" (use a synthetic user name from .github/privacy-allowlist.json, such as "test")` });
    }
    for (const e of findEmails(text, file, allow, existingEmails)) {
      findings.push({ file, line, message: `email address "${e}" (use an example.com address)` });
    }
  }
  const assetDirs = "public/, src/assets/, src-tauri/icons/ or docs/design-system/";
  for (const { file, binary, from } of newFiles) {
    if (isForbiddenNewFile(file, binary, allow)) {
      findings.push({
        file,
        message: from
          ? `binary or data file moved here from ${from}, which is outside ${assetDirs}`
          : `new binary or data file outside ${assetDirs}`,
      });
    }
  }
  commitMessages.forEach((msg, i) => {
    for (const p of findPersonalPaths(msg, allow)) {
      findings.push({ message: `commit message ${i + 1} contains personal path "${p}"` });
    }
  });
  return findings;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/**
 * Email addresses in the base tree, with the files that contain each.
 * `git grep` prints `<ref>:<path>:<match>`; addresses never contain ":".
 * @returns {Map<string, Set<string>>}
 */
export function parseGrepEmails(out, ref) {
  const map = new Map();
  for (const row of out.split("\n")) {
    if (!row.startsWith(`${ref}:`)) continue;
    const rest = row.slice(ref.length + 1);
    const cut = rest.lastIndexOf(":");
    if (cut <= 0) continue;
    const file = rest.slice(0, cut);
    const address = rest.slice(cut + 1).toLowerCase();
    if (!map.has(address)) map.set(address, new Set());
    map.get(address).add(file);
  }
  return map;
}

function existingEmailsAt(ref) {
  let out = "";
  try {
    out = git(["grep", "-I", "-o", "-E", "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}", ref, "--"]);
  } catch (err) {
    if (err.status !== 1) throw err; // 1 = no matches
  }
  return parseGrepEmails(out, ref);
}

/**
 * Files that are new at `head`: added ones, and renamed ones with the path
 * they came from (so a moved image gets a message that says so).
 * @param {string} nameStatus `git diff --name-status -z -M --diff-filter=AR`
 * @param {Set<string>} binaries paths git reports as binary
 */
export function parseNewFiles(nameStatus, binaries) {
  const parts = nameStatus.split("\0").filter((p) => p !== "");
  const files = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    if (status.startsWith("R")) {
      const from = parts[i++];
      const file = parts[i++];
      files.push({ file, binary: binaries.has(file), from });
    } else {
      const file = parts[i++];
      files.push({ file, binary: binaries.has(file) });
    }
  }
  return files;
}

function parseArgs(argv) {
  const args = { head: "HEAD" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") args.base = argv[++i];
    else if (argv[i] === "--head") args.head = argv[++i];
  }
  return args;
}

function main() {
  const { base, head } = parseArgs(process.argv.slice(2));
  if (!base) {
    console.error("usage: privacy-check.mjs --base <ref> [--head <ref>]");
    process.exit(2);
  }
  const allowPath = fileURLToPath(new URL("../.github/privacy-allowlist.json", import.meta.url));
  const allow = JSON.parse(readFileSync(allowPath, "utf8"));
  const range = `${base}...${head}`;
  const excludes = SKIPPED_FILES.map((f) => `:(exclude)${f}`);

  const added = parseAddedLines(git(["diff", "--unified=0", "--no-color", "--no-ext-diff", range, "--", ".", ...excludes]));
  const binaries = new Set(
    git(["diff", "--numstat", "-z", "--diff-filter=AR", "--no-renames", range])
      .split("\0")
      .filter((row) => row.startsWith("-\t-\t"))
      .map((row) => row.slice(4)),
  );
  const newFiles = parseNewFiles(git(["diff", "--name-status", "-z", "-M", "--diff-filter=AR", range]), binaries);
  const commitMessages = git(["log", "--format=%B%x00", `${base}..${head}`]).split("\0").map((s) => s.trim()).filter(Boolean);
  const mergeBase = git(["merge-base", base, head]).trim();

  const findings = checkPrivacy({ added, newFiles, commitMessages, existingEmails: existingEmailsAt(mergeBase), allow });
  const inActions = process.env.GITHUB_ACTIONS === "true";
  for (const f of findings) {
    const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}: ` : "";
    console.log(`FAIL ${where}${f.message}`);
    if (inActions && f.file) console.log(`::error file=${f.file}${f.line ? `,line=${f.line}` : ""}::${f.message}`);
  }
  console.log(
    findings.length === 0
      ? `privacy: PASS (${added.length} added lines, ${newFiles.length} new files, ${commitMessages.length} commits checked)`
      : `\nprivacy: FAIL (${findings.length} finding${findings.length === 1 ? "" : "s"}). Fix them, or extend .github/privacy-allowlist.json with a synthetic entry and say why in the pull request.`,
  );
  process.exit(findings.length === 0 ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

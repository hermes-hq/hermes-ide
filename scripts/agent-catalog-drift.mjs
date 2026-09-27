#!/usr/bin/env node
// Agent CLI drift check.
//
// Every flag and subcommand the agent catalog (src/catalog/agents.json) uses
// must still exist in the latest release of that agent's CLI. This script
// asks each installed CLI for its --help and fails with a diff when something
// the catalog relies on is gone. It never starts a model turn and needs no
// credentials.
//
//   node scripts/agent-catalog-drift.mjs                 # check what is installed
//   node scripts/agent-catalog-drift.mjs --install       # install the latest CLIs first (CI)
//   node scripts/agent-catalog-drift.mjs --only codex,claude --out <dir>
//
// Options:
//   --install        run each agent's documented install command first
//                    (install.ci when the documented one asks questions)
//   --require-all    fail when an agent's CLI cannot be found
//                    (implied by --install)
//   --only a,b       check only these agent ids
//   --out <dir>      write report.md, report.json and each --help output
//   --catalog <file> check another catalog file (used to prove the check fails)
//   --real-home      read --help with the real HOME (CI: the runner's home is
//                    throwaway, and some CLIs find their own install via HOME)
//
// Help is read with a throwaway HOME (unless --real-home) so no CLI touches
// the real one.
// Exit code: 0 all good, 1 drift (or a missing CLI with --require-all),
// 2 usage error.
//
// The nightly workflow .github/workflows/agent-cli-drift.yml runs this with
// --install on a clean runner.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CATALOG_PATH = resolve(HERE, "..", "src", "catalog", "agents.json");

const PLACEHOLDER = /^\{[a-z_]+\}$/;
const FLAG = /^-{1,2}[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Strips ANSI escape sequences (colours, cursor moves) from help text. */
export function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, "");
}

/**
 * Turns one argument list of the catalog into what must exist in the CLI.
 * `base` is the command the list is appended to (["codex"] or
 * ["goose", "session"]). Words at the start of the list are subcommands
 * (each extends the command whose help is read); a word after a flag is that
 * flag's value; `{placeholders}` are filled at launch and not checked.
 *
 * Returns [{ path, kind: "flag"|"subcommand"|"value", token, flag? }].
 */
export function requirementsOf(base, args) {
  const out = [];
  let path = [...base];
  let prevFlag = null;
  let subcommandsAllowed = true;
  args.forEach((raw) => {
    if (PLACEHOLDER.test(raw)) { prevFlag = null; subcommandsAllowed = false; return; }
    const eq = raw.indexOf("=");
    const token = raw.startsWith("-") && eq > 0 ? raw.slice(0, eq) : raw;
    if (token.startsWith("-")) {
      if (FLAG.test(token)) out.push({ path: [...path], kind: "flag", token });
      prevFlag = eq > 0 ? null : token;
      subcommandsAllowed = false;
      return;
    }
    if (subcommandsAllowed && /^[a-z][a-z0-9-]*$/.test(token)) {
      out.push({ path: [...path], kind: "subcommand", token });
      path = [...path, token];
      prevFlag = null;
      return;
    }
    // A flag's value. Only plain words are checked (choices such as
    // "workspace-write" or "auto_edit"); config values like `a.b=true` are not.
    if (prevFlag && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(token)) {
      out.push({ path: [...path], kind: "value", token, flag: prevFlag });
    }
    prevFlag = null;
    subcommandsAllowed = false;
  });
  return out;
}

/** Everything one catalog entry uses, each tagged with where in the entry it comes from. */
export function probesFor(agent) {
  if (agent.custom || !agent.terminal?.argv?.length) return [];
  const argv = agent.terminal.argv;
  const t = agent.terminal;
  const lists = [];
  // argv itself: argv[0] is the binary, the rest are subcommands.
  lists.push(["terminal.argv", [argv[0]], argv.slice(1)]);
  lists.push(["terminal.resume.by_id", argv, t.resume?.by_id]);
  lists.push(["terminal.resume.latest", argv, t.resume?.latest]);
  lists.push(["terminal.new_session_id", argv, t.new_session_id]);
  lists.push(["terminal.initial_prompt", argv, t.initial_prompt]);
  lists.push(["terminal.signals.args", argv, t.signals?.args]);
  for (const [mode, flags] of Object.entries(t.permission_flags ?? {})) {
    lists.push([`terminal.permission_flags.${mode}`, argv, flags]);
  }
  lists.push(["structured.args", [argv[0]], agent.structured?.args]);
  // detect.command is checked by running it (see main), not against --help:
  // many CLIs print their version without listing --version.
  if (agent.auth?.check) lists.push(["auth.check", [agent.auth.check[0]], agent.auth.check.slice(1)]);
  const probes = [];
  for (const [where, base, args] of lists) {
    if (!args?.length) continue;
    for (const r of requirementsOf(base, args)) probes.push({ ...r, where });
  }
  return probes;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `help` lists `token`, as a whole flag / word (not a prefix of a longer one). */
export function helpMentions(help, token, kind) {
  const text = stripAnsi(help);
  const t = escapeRe(token);
  if (kind === "flag") {
    return new RegExp(`(^|[\\s,\\[(|/])${t}(?=$|[\\s,=\\]\\)|<\\[.:;])`, "m").test(text);
  }
  return new RegExp(`(^|[^A-Za-z0-9_-])${t}(?=$|[^A-Za-z0-9_-])`, "m").test(text);
}

/**
 * Checks probes against the help text of each command path.
 * `helpFor(path)` returns the help text (string) or null when it could not be read.
 * Returns the problems found: [{ where, kind, token, command, reason }].
 */
export function findDrift(probes, helpFor) {
  const problems = [];
  for (const p of probes) {
    const command = p.path.join(" ");
    const help = helpFor(p.path);
    if (help == null || !help.trim()) {
      problems.push({ ...p, command, reason: `\`${command} --help\` printed nothing` });
      continue;
    }
    if (!helpMentions(help, p.token, p.kind === "flag" ? "flag" : "word")) {
      const what = p.kind === "value" ? `value "${p.token}" of ${p.flag}` : `${p.kind} "${p.token}"`;
      problems.push({ ...p, command, reason: `${what} is not in \`${command} --help\`` });
    }
  }
  return problems;
}

/** A diff-style report: "-" lines are what the catalog uses and the CLI no longer offers. */
export function formatReport(results, { requireAll = true } = {}) {
  const lines = ["--- src/catalog/agents.json (what Hermes passes)", "+++ latest CLIs (--help)"];
  for (const r of results) {
    const header = `@@ ${r.id} ${r.version ? `(${r.version.split("\n")[0].trim()})` : ""}`.trimEnd() + " @@";
    lines.push(header);
    if (r.status === "missing") {
      lines.push(requireAll
        ? `- ${r.id}: CLI not found${r.installError ? ` (install failed: ${r.installError})` : ""}`
        : "  skipped: not installed here");
      continue;
    }
    if (!r.problems.length) { lines.push(`  ok: ${r.checked} flags and subcommands still exist`); continue; }
    for (const p of r.problems) lines.push(`- ${r.id} ${p.where}: ${p.reason}`);
  }
  return lines.join("\n") + "\n";
}

// ─── CLI ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { install: false, requireAll: false, only: null, out: null, catalog: CATALOG_PATH, realHome: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--install") { opts.install = true; opts.requireAll = true; }
    else if (a === "--require-all") opts.requireAll = true;
    else if (a === "--only") opts.only = new Set((argv[++i] ?? "").split(",").filter(Boolean));
    else if (a === "--out") opts.out = resolve(argv[++i] ?? "");
    else if (a === "--catalog") opts.catalog = resolve(argv[++i] ?? "");
    else if (a === "--real-home") opts.realHome = true;
    else { console.error(`unknown option: ${a}`); process.exit(2); }
  }
  return opts;
}

/** Where installers put binaries, so a fresh install is found without a new shell. */
function searchPath(home) {
  const extra = [
    join(home, ".local", "bin"),
    join(home, ".opencode", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const npmPrefix = spawnSync("npm", ["prefix", "-g"], { encoding: "utf8", shell: process.platform === "win32" }).stdout?.trim();
  if (npmPrefix) extra.push(process.platform === "win32" ? npmPrefix : join(npmPrefix, "bin"));
  return [...new Set([...(process.env.PATH ?? "").split(delimiter), ...extra])].filter(Boolean).join(delimiter);
}

function which(bin, PATH) {
  const r = spawnSync(process.platform === "win32" ? "where" : "sh", process.platform === "win32" ? [bin] : ["-c", `command -v ${bin}`], {
    encoding: "utf8",
    env: { ...process.env, PATH },
  });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

function run(file, args, env, timeoutMs = 60_000) {
  const r = spawnSync(file, args, { encoding: "utf8", env, timeout: timeoutMs, input: "", maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, text: `${r.stdout ?? ""}\n${r.stderr ?? ""}`, error: r.error?.message };
}

function install(agent, PATH) {
  const cmd = agent.install?.ci ?? agent.install?.command;
  if (!cmd) return "no install command";
  console.log(`install ${agent.id}: ${cmd}`);
  const r = spawnSync("bash", ["-c", cmd], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, PATH, CI: "true", NONINTERACTIVE: "1" },
    timeout: 15 * 60_000,
  });
  return r.status === 0 ? null : `exit ${r.status ?? r.signal ?? r.error?.message}`;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const catalog = JSON.parse(readFileSync(opts.catalog, "utf8"));
  const agents = catalog.agents.filter((a) => !a.custom && (!opts.only || opts.only.has(a.id)));
  const PATH = searchPath(homedir());
  const helpHome = mkdtempSync(join(tmpdir(), "hermes-drift-home-"));
  const homeEnv = opts.realHome ? {} : { HOME: helpHome, USERPROFILE: helpHome };
  const helpEnv = { ...process.env, PATH, ...homeEnv, NO_COLOR: "1", TERM: "dumb", CI: "true" };
  if (opts.out) mkdirSync(opts.out, { recursive: true });

  const results = [];
  try {
    for (const agent of agents) {
      const bin = agent.detect.command[0];
      let installError = null;
      if (opts.install) installError = install(agent, PATH);
      const exe = which(bin, PATH);
      if (!exe) { results.push({ id: agent.id, status: "missing", installError, problems: [], checked: 0 }); continue; }
      const detect = run(exe, agent.detect.command.slice(1), helpEnv);
      const version = detect.text.trim();
      const cache = new Map();
      const helpFor = (path) => {
        const key = path.join(" ");
        if (!cache.has(key)) {
          const r = run(exe, [...path.slice(1), "--help"], helpEnv);
          cache.set(key, r.text);
          if (opts.out) writeFileSync(join(opts.out, `${key.replace(/[^A-Za-z0-9._-]+/g, "_")}.help.txt`), r.text);
        }
        return cache.get(key);
      };
      const probes = probesFor(agent);
      const problems = findDrift(probes, helpFor);
      if (detect.status !== 0) {
        problems.push({ where: "detect.command", kind: "command", token: agent.detect.command.join(" "), reason: `\`${agent.detect.command.join(" ")}\` exited ${detect.status ?? detect.error}` });
      }
      results.push({ id: agent.id, status: problems.length ? "drift" : "ok", version, problems, checked: probes.length });
    }
  } finally {
    rmSync(helpHome, { recursive: true, force: true });
  }

  const report = formatReport(results, { requireAll: opts.requireAll });
  process.stdout.write(report);
  if (opts.out) {
    writeFileSync(join(opts.out, "report.md"), "```diff\n" + report + "```\n");
    writeFileSync(join(opts.out, "report.json"), JSON.stringify(results, null, 2) + "\n");
  }
  const drift = results.filter((r) => r.status === "drift");
  const missing = results.filter((r) => r.status === "missing");
  if (drift.length || (opts.requireAll && missing.length)) {
    console.error(`\nFAIL: ${drift.length} agent(s) drifted${opts.requireAll ? `, ${missing.length} missing` : ""}.`);
    return 1;
  }
  if (missing.length) console.log(`\n(${missing.length} agent(s) not installed here and skipped: ${missing.map((m) => m.id).join(", ")})`);
  console.log("\nPASS: every flag and subcommand the catalog uses still exists.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && existsSync(CATALOG_PATH)) {
  process.exit(main());
}

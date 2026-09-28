#!/usr/bin/env node
// A fake agent that drives a Feature Track (F28) the way a real one would,
// from inside a Hermes terminal: only through the files and the `hi` helper.
// It also misbehaves on purpose once, so the scenario can prove the guard.
//
//   node track-agent.mjs --hi <path to hi> --ctl <folder> --log <file.jsonl> --slug <slug>
//
// It sets HERMES_AGENT in its own environment, as Hermes does for every
// agent it launches, so `hi approve` must refuse it. Each step prints one
// `track-agent: ...` line the scenario waits for, and appends a JSON line to
// the log. Sync points wait for a `go-<name>` file in the control folder
// (the scenario creates it) or for a state in feature.md.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import readline from "node:readline";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const HI = args.hi || "hi";
const CTL = args.ctl;
const SLUG = args.slug || "demo-search";
const LOG = args.log;
if (!CTL) {
  process.stderr.write("track-agent: --ctl <folder> is required\n");
  process.exit(2);
}
fs.mkdirSync(CTL, { recursive: true });
process.env.HERMES_AGENT = "fake";

const t0 = Date.now();
const log = (o) => {
  if (LOG) fs.appendFileSync(LOG, JSON.stringify({ t: Date.now() - t0, ...o }) + "\n");
};
const say = (line) => {
  process.stdout.write(`track-agent: ${line}\n`);
  log({ say: line });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const featureDir = path.join(process.cwd(), ".hermes", "features", SLUG);
const featureFile = path.join(featureDir, "feature.md");
function meta() {
  try {
    const text = fs.readFileSync(featureFile, "utf8");
    const get = (k) => text.match(new RegExp(`^${k}:\\s*(\\S+)`, "m"))?.[1] ?? null;
    return { phase: get("phase"), gate: get("gate"), text };
  } catch {
    return null;
  }
}

function hi(...cmd) {
  const r = spawnSync(HI, cmd, { encoding: "utf8", env: process.env, cwd: process.cwd() });
  const out = (r.stdout || "").trim();
  const err = (r.stderr || "").trim();
  log({ hi: cmd, code: r.status, stdout: out.slice(0, 400), stderr: err.slice(0, 400) });
  return { code: r.status, out, err };
}

async function waitFor(what, test, timeoutMs = 120_000) {
  const start = Date.now();
  for (;;) {
    const v = test();
    if (v) return { value: v, ms: Date.now() - start };
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}
const waitGo = (name) => waitFor(`go-${name}`, () => fs.existsSync(path.join(CTL, `go-${name}`)));
const waitGate = (gate, phase) =>
  waitFor(`gate ${gate}${phase ? ` at ${phase}` : ""}`, () => {
    const m = meta();
    return m && m.gate === gate && (!phase || m.phase === phase) ? m : null;
  });

// One line from stdin (the person's `r`), while the rest keeps running.
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const stdinLines = [];
rl.on("line", (line) => {
  stdinLines.push(line);
  log({ stdin: line });
});

try {
  // 1. A Light track feature on this worktree.
  let r = hi("feature", "new", SLUG, "--track", "Light", "--title", "Demo search");
  if (r.code !== 0) throw new Error(`hi feature new failed: ${r.err}`);
  say(`feature created (${r.out.split("\n")[0]})`);

  // 2. Questions: one blocking, one plain; hand over.
  r = hi("phase");
  if (r.code !== 0 || !r.out.startsWith("# Phase: questions")) throw new Error(`hi phase: ${r.code} ${r.err}`);
  fs.writeFileSync(
    path.join(featureDir, "questions.md"),
    "# Questions\n\n## Blocking\n- [ ] ! Which search engine do we index with?\n\n## Open\n- [ ] Should results be cached?\n",
  );
  r = hi("phase", "done");
  if (r.code !== 0) throw new Error(`hi phase done: ${r.err}`);
  say("questions handed over");
  await waitGate("approved", "plan");
  say("questions approved");
  await waitGo("plan");

  // 3. Plan: first over the cap (refused), then within it; hand over.
  r = hi("phase");
  if (r.code !== 0 || !r.out.startsWith("# Phase: plan")) throw new Error(`hi phase (plan): ${r.code} ${r.err}`);
  fs.writeFileSync(path.join(featureDir, "plan.md"), "# Plan\n\n" + "- [ ] step\n".repeat(119));
  r = hi("phase", "done");
  say(`plan over cap: hi phase done exit ${r.code} (${r.err.replace(/\s+/g, " ").slice(0, 90)})`);
  fs.writeFileSync(path.join(featureDir, "plan.md"), "# Plan\n\n- [ ] build the index\n- [ ] answer queries\n");
  r = hi("phase", "done");
  if (r.code !== 0) throw new Error(`hi phase done (plan): ${r.err}`);
  say("plan handed over");

  // 4. The person sends edits back: one tagged line arrives on stdin.
  const review = await waitFor("a review line on stdin", () => stdinLines.find((l) => l.startsWith("hermes review:")) ?? null);
  const file = review.value.match(/read (\S+) and/)?.[1] ?? "";
  const reviewText = fs.existsSync(path.join(process.cwd(), file)) ? fs.readFileSync(path.join(process.cwd(), file), "utf8") : "";
  log({ review: file, bytes: reviewText.length, hasDiff: reviewText.includes("```diff") });
  say(`got review ${file} (${reviewText.includes("```diff") ? "diff" : "whole file"})`);

  // 5. Misbehave: try to approve the gate, then forge the approval by hand.
  await waitGo("forge");
  r = hi("approve");
  say(`hi approve exit ${r.code}`);
  const before = meta();
  fs.writeFileSync(featureFile, before.text.replace(/^phase:.*$/m, "phase: implement").replace(/^gate:.*$/m, "gate: approved"));
  const forgedAt = Date.now();
  say("forged approval");
  try {
    const back = await waitGate("waiting", "plan", 15_000);
    say(`reverted after ${Date.now() - forgedAt} ms`);
    log({ reverted: true, ms: back.ms });
  } catch {
    say("NOT reverted");
  }

  // 6. The person approves the plan for real; implement, hand over, done.
  await waitGate("approved", "implement");
  say("plan approved");
  await waitGo("implement");
  r = hi("phase");
  if (r.code !== 0 || !r.out.startsWith("# Phase: implement")) throw new Error(`hi phase (implement): ${r.code} ${r.err}`);
  fs.writeFileSync(path.join(process.cwd(), "search.txt"), "index + query\n");
  r = hi("phase", "done");
  if (r.code !== 0) throw new Error(`hi phase done (implement): ${r.err}`);
  say("implement handed over");
  await waitGate("approved", "done");
  say("done");
  rl.close();
  process.exit(0);
} catch (e) {
  say(`FAILED ${e.message}`);
  rl.close();
  process.exit(1);
}

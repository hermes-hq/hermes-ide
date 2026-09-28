#!/usr/bin/env node
// Scenario: F30 — one instruction file (AGENTS.md), per-agent chip, read-only
// MCP view across attached folders.
//
// Proves, on the REAL app, with a fake agent started as Codex and as Claude
// (the launch line is the real one; the program is ours, see
// ../agent-setup-steps.mjs) and synthetic folders:
//
//   project/   AGENTS.md, .mcp.json { "proj-docs" }
//   shared/    CLAUDE.md, .mcp.json { "shared-db" }, .claude/skills/deploy
//   home       ~/.claude.json { "user-wide" }   (macOS / Linux private home)
//
//   1. A Codex session in project/ (shared/ attached): the chip lists
//      AGENTS.md.
//   2. A Claude session in the same folders: the chip says no instruction
//      file. Its view lists what each agent sees: Claude's MCP servers from
//      the project (proj-docs), the user config (user-wide) and the attached
//      folder (shared-db, "not loaded"); the attached CLAUDE.md and skill
//      are listed as not loaded.
//   3. "Link CLAUDE.md to AGENTS.md": CLAUDE.md is created with @AGENTS.md
//      and the chip lists CLAUDE.md + AGENTS.md ("linked from CLAUDE.md").
//   4. Nothing Hermes did changed ~/.claude.json (byte-identical).
//
// Negative control: HERMES_E2E_SKIP_LINK=1 skips the click in step 3; the
// run must end in RESULT: FAIL (the chip keeps saying no instruction file).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F30-instruction-files.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { launcher, launchWithCatalogFlag, onWindows, quitFakeAgent, readChips, startAgentSession, writeFakeAgent } from "../agent-setup-steps.mjs";

const SKIP_LINK = process.env.HERMES_E2E_SKIP_LINK === "1";

await runScenario("F30-instruction-files", async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  log(`platform: ${process.platform}${SKIP_LINK ? "   NEGATIVE CONTROL: the link is not clicked" : ""}`);
  const fake = writeFakeAgent("f30");
  onCleanup(fake.cleanup);

  log("step 1: synthetic folders and a private home");
  const root = mkdtempSync(join(tmpdir(), "hermes-e2e-f30-"));
  onCleanup(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const project = join(root, "f30-project");
  const shared = join(root, "f30-shared");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(shared, ".claude", "skills", "deploy"), { recursive: true });
  writeFileSync(join(project, "AGENTS.md"), "# Project rules\n\nUse tabs.\n");
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { "proj-docs": { command: "npx", env: { TOKEN: "synthetic" } } } }));
  writeFileSync(join(shared, "CLAUDE.md"), "# Shared library\n");
  writeFileSync(join(shared, ".mcp.json"), JSON.stringify({ mcpServers: { "shared-db": { command: "db" } } }));
  writeFileSync(join(shared, ".claude", "skills", "deploy", "SKILL.md"), "---\nname: deploy\n---\n");

  const homeDir = onWindows ? undefined : join(root, "home");
  let userConfig = null;
  if (homeDir) {
    mkdirSync(homeDir, { recursive: true });
    userConfig = join(homeDir, ".claude.json");
    writeFileSync(userConfig, JSON.stringify({ mcpServers: { "user-wide": { command: "uw" } } }, null, 2));
  } else if (existsSync(join(homedir(), ".claude.json"))) {
    userConfig = join(homedir(), ".claude.json"); // read-only check on the Windows runner
  }
  const userBefore = userConfig ? readFileSync(userConfig) : null;

  log("step 2: launch with the agentCatalog flag on");
  const app = await launchWithCatalogFlag({ launch: launcher({ evidenceDir, log, homeDir }), log, apps });
  const { bridge } = app;

  log("step 3: a Codex session in the project (shared folder attached) lists AGENTS.md");
  const codex = await startAgentSession(bridge, log, { agent: "codex", prefix: fake.prefixFor("codex"), folders: [project, shared], label: "F30 codex" });
  assert(/^FAKE-AGENT codex\b/.test(codex.bannerLine), "the fake agent was started as Codex");
  const codexChips = await bridge.waitFor("the Codex instructions chip", `
    const c = e2e.first(".agent-setup-chips");
    return c && c.getAttribute("data-agent-id") === "codex" && c.getAttribute("data-files") !== "" ? c.getAttribute("data-files") : null;
  `, { timeoutMs: 20_000 });
  log(`  codex chip: ${JSON.stringify(await readChips(bridge))}`);
  assert(codexChips === "AGENTS.md", `the chip on the Codex session lists AGENTS.md (${codexChips})`);
  await bridge.screenshot(join(evidenceDir, "01-codex-agents-md.png"));
  await quitFakeAgent(bridge, codex.sessionId);

  log("step 4: a Claude session in the same folders: no instruction file yet");
  const claude = await startAgentSession(bridge, log, { agent: "claude", prefix: fake.prefixFor("claude"), folders: [project, shared], label: "F30 claude" });
  assert(/^FAKE-AGENT claude\b/.test(claude.bannerLine), "the fake agent was started as Claude");
  await bridge.waitFor("the Claude chip", `
    const c = e2e.first(".agent-setup-chips");
    return c && c.getAttribute("data-agent-id") === "claude" && e2e.norm(c.querySelector(".agent-rules-chip")?.innerText ?? "") !== "…";
  `, { timeoutMs: 20_000 });
  let chips = await readChips(bridge);
  log(`  claude chip: ${JSON.stringify(chips)}`);
  assert(chips.label === "No instruction file", `Claude loads no instruction file before the link ("${chips.label}")`);

  log("step 5: the view lists what each agent sees, read-only");
  await bridge.click(".agent-setup-chips .agent-rules-chip");
  await bridge.waitFor("the setup view with its MCP servers", `return !!e2e.first('.agent-setup-popover .agent-setup-mcp[data-loaded="true"]');`);
  const view = await bridge.eval(`
    const p = e2e.first(".agent-setup-popover");
    const claudeMcp = p.querySelector('.agent-setup-mcp-agent[data-agent-id="claude"]');
    const rows = (root) => Array.from(root?.querySelectorAll("li") ?? []).map((li) => ({
      text: e2e.norm(li.innerText), scope: li.getAttribute("data-scope"), notLoaded: li.classList.contains("agent-setup-not-loaded"),
    }));
    return {
      text: e2e.norm(p.innerText),
      claudeMcp: rows(claudeMcp),
      agentsWithMcp: Array.from(p.querySelectorAll(".agent-setup-mcp-agent")).map((a) => a.getAttribute("data-agent-id")),
      sections: Array.from(p.querySelectorAll(".agent-setup-section")).map((s) => ({ title: e2e.norm(s.querySelector(".agent-setup-section-title")?.innerText ?? ""), rows: rows(s) })),
      link: e2e.norm(p.querySelector(".agent-setup-link-btn")?.innerText ?? ""),
    };
  `);
  log(`  view: ${JSON.stringify(view)}`);
  const mcpRow = (name) => view.claudeMcp.find((r) => r.text.startsWith(name));
  assert(mcpRow("proj-docs") && !mcpRow("proj-docs").notLoaded, "Claude sees the project's MCP server (proj-docs)");
  assert(mcpRow("shared-db") && mcpRow("shared-db").notLoaded && mcpRow("shared-db").scope === "attached", "the attached folder's MCP server is listed as not loaded");
  if (homeDir) assert(mcpRow("user-wide") && mcpRow("user-wide").scope === "global", "the user-wide MCP server is listed");
  assert(view.agentsWithMcp[0] === "claude" && view.agentsWithMcp.includes("codex"), `the view lists each agent's servers, this one first (${view.agentsWithMcp.join(", ")})`);
  assert(!view.text.includes("synthetic"), "MCP secrets are never shown");
  const instr = view.sections.find((s) => s.title.toLowerCase() === "instruction files");
  assert(instr?.rows.some((r) => r.scope === "attached" && r.notLoaded && r.text.includes("CLAUDE.md")), "the attached folder's CLAUDE.md is listed as not loaded");
  const skills = view.sections.find((s) => s.title.toLowerCase() === "skills");
  assert(skills?.rows.some((r) => r.text.includes("deploy") && r.notLoaded), "the attached folder's skill is listed as not loaded");
  assert(view.link === "Link CLAUDE.md to AGENTS.md", `the link is offered ("${view.link}")`);
  await bridge.screenshot(join(evidenceDir, "02-claude-setup-view.png"));

  log("step 6: link CLAUDE.md to AGENTS.md");
  if (!SKIP_LINK) await bridge.click(".agent-setup-link-btn");
  await bridge.waitFor("the chip to list CLAUDE.md and AGENTS.md", `
    return e2e.first(".agent-setup-chips")?.getAttribute("data-files") === "CLAUDE.md,AGENTS.md";
  `, { timeoutMs: 15_000 });
  chips = await readChips(bridge);
  log(`  claude chip: ${JSON.stringify(chips)}`);
  assert(chips.label === "CLAUDE.md + AGENTS.md", `the chip on the Claude session lists CLAUDE.md and the linked AGENTS.md ("${chips.label}")`);
  const linked = await bridge.eval(`return e2e.norm(e2e.first(".agent-setup-popover")?.innerText ?? "");`);
  assert(linked.includes("linked from CLAUDE.md"), "the view marks AGENTS.md as linked from CLAUDE.md");
  const claudeMd = readFileSync(join(project, "CLAUDE.md"), "utf8");
  assert(claudeMd === "@AGENTS.md\n", `CLAUDE.md on disk is the link (${JSON.stringify(claudeMd)})`);
  await bridge.settle();
  await bridge.screenshot(join(evidenceDir, "03-claude-linked.png"));
  await sleep(200);

  log("step 7: the user config was never written");
  if (userConfig) {
    assert(Buffer.compare(readFileSync(userConfig), userBefore) === 0, "~/.claude.json is byte-identical");
  } else {
    log("  (no ~/.claude.json on this machine; nothing to compare)");
  }
  await quitFakeAgent(bridge, claude.sessionId);
});

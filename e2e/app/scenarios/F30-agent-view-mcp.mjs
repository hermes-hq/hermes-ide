#!/usr/bin/env node
// Scenario: F30 — in Agent view, Hermes edits only the project's .mcp.json.
//
// With the agentCatalog flag on, the Agent view's MCP servers are added to
// and removed from the project's .mcp.json, never ~/.claude.json. So a
// server set up anywhere else must not offer Remove (removing it from the
// project file would silently do nothing and it would be back on the next
// start). Proves, on the REAL app, with a fake Claude bridge
// (e2e/app/fixtures/fake-claude-bridge.mjs through HERMES_BRIDGE_PATH, no
// account, no network) and synthetic folders:
//
//   project/  .mcp.json { "proj-docs" }
//   home      ~/.claude.json { "user-wide" }   (macOS / Linux private home;
//             on Windows the fake bridge alone reports "user-wide")
//
//   1. An Agent view session in project/ lists both servers.
//   2. "user-wide" offers no Remove; it says Hermes will not edit it.
//   3. "proj-docs" offers Remove; confirming it removes it from the
//      project's .mcp.json and the row goes away.
//   4. ~/.claude.json is byte-identical.
//
// Negative control: HERMES_E2E_NEGATIVE=1 leaves the flag off (1.x: Remove is
// offered for every server); the run must end in RESULT: FAIL at step 2.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F30-agent-view-mcp.mjs

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { launcher, launchWithCatalogFlag, onWindows, sendAgentMessage, startAgentViewSession } from "../agent-setup-steps.mjs";

const NEGATIVE = process.env.HERMES_E2E_NEGATIVE === "1";

await runScenario("F30-agent-view-mcp", async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  log(`platform: ${process.platform}${NEGATIVE ? "   NEGATIVE CONTROL: the agentCatalog flag is left off" : ""}`);

  log("step 1: synthetic project, private home and a fake Claude bridge");
  const root = mkdtempSync(join(tmpdir(), "hermes-e2e-f30mcp-"));
  onCleanup(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const project = join(root, "f30-mcp-project");
  mkdirSync(project, { recursive: true });
  const projectMcp = join(project, ".mcp.json");
  writeFileSync(projectMcp, JSON.stringify({ mcpServers: { "proj-docs": { command: "npx", env: { TOKEN: "synthetic" } } } }, null, 2));
  const bridgeCopy = join(root, "fake-claude-bridge.mjs");
  copyFileSync(join(REPO_ROOT, "e2e", "app", "fixtures", "fake-claude-bridge.mjs"), bridgeCopy);

  const homeDir = onWindows ? undefined : join(root, "home");
  let userConfig = null;
  if (homeDir) {
    mkdirSync(homeDir, { recursive: true });
    userConfig = join(homeDir, ".claude.json");
    writeFileSync(userConfig, JSON.stringify({ mcpServers: { "user-wide": { command: "uw", env: { SECRET: "synthetic" } } } }, null, 2));
  }
  const userBefore = userConfig ? readFileSync(userConfig) : null;
  const env = { HERMES_BRIDGE_PATH: bridgeCopy, HERMES_FAKE_MCP_SERVERS: "proj-docs,user-wide" };

  log("step 2: launch with the agentCatalog flag on");
  const app = await launchWithCatalogFlag({ launch: launcher({ evidenceDir, log, homeDir, env }), log, apps, flagOn: !NEGATIVE });
  const { bridge } = app;

  log("step 3: an Agent view session in the project lists both servers");
  await startAgentViewSession(bridge, log, { folder: project });
  await sendAgentMessage(bridge, log, "hello");
  await bridge.waitFor("the fake agent's reply", `return document.body.innerText.includes("fake reply: hello");`, { timeoutMs: 30_000 });
  if (!(await bridge.exists(".workbench-panel"))) {
    await bridge.click('.activity-bar-right [data-tab-id="workbench"]');
  }
  await bridge.waitFor("the workbench", `return !!e2e.first(".workbench-panel");`);
  await bridge.clickWhenReady(`
    const tab = e2e.all(".workbench-tab").find((b) => e2e.norm(b.innerText).toLowerCase() === "context");
    return e2e.click(e2e.must(tab, "the workbench's Context tab"));
  `);
  const MCP = `.workbench-panel .agent-context-section[data-section="mcp"]`;
  const names = await bridge.waitFor("both MCP servers", `
    const n = e2e.all(${JSON.stringify(`${MCP} .mcp-row .mcp-name`)}).map((e) => e2e.norm(e.innerText));
    return n.includes("proj-docs") && n.includes("user-wide") ? n : null;
  `, { timeoutMs: 20_000 });
  log(`  servers listed: ${names.join(", ")}`);

  const row = (name) => `e2e.all(${JSON.stringify(`${MCP} .mcp-row`)}).find((r) => e2e.norm(r.querySelector(".mcp-name")?.innerText ?? "") === ${JSON.stringify(name)})`;
  /** Expands a row and waits for its details to finish loading. */
  async function expand(name) {
    await bridge.clickWhenReady(`return e2e.click(e2e.must(${row(name)}?.querySelector(".mcp-row-header"), "the ${name} row"));`);
    return bridge.waitFor(`the ${name} details`, `
      const r = ${row(name)};
      if (!r || !r.querySelector(".mcp-row-body") || r.querySelector(".mcp-spec-loading")) return null;
      return {
        remove: !!Array.from(r.querySelectorAll(".mcp-action")).find((b) => e2e.norm(b.innerText) === "remove"),
        note: e2e.norm(r.querySelector(".mcp-kept-note")?.innerText ?? ""),
        text: e2e.norm(r.innerText),
      };
    `);
  }

  log("step 4: a server set up outside the project offers no Remove");
  const userWide = await expand("user-wide");
  log(`  user-wide: ${JSON.stringify(userWide)}`);
  await bridge.screenshot(join(evidenceDir, "01-user-wide.png"));
  assert(!userWide.remove, "user-wide offers no Remove");
  assert(/Hermes will not edit it/.test(userWide.note), "user-wide says Hermes will not edit it");
  assert(!userWide.text.includes("synthetic"), "no MCP secret is shown");

  log("step 5: the project's own server can be removed from the project's .mcp.json");
  const proj = await expand("proj-docs");
  log(`  proj-docs: ${JSON.stringify(proj)}`);
  assert(proj.remove && !proj.note, "proj-docs offers Remove");
  await bridge.clickWhenReady(`
    const b = Array.from(${row("proj-docs")}.querySelectorAll(".mcp-action")).find((x) => e2e.norm(x.innerText) === "remove");
    return e2e.click(e2e.must(b, "Remove"));
  `);
  const confirm = await bridge.waitFor("the confirmation", `return e2e.norm(${row("proj-docs")}?.querySelector(".mcp-confirm-text")?.innerText ?? "") || null;`);
  log(`  confirmation: ${confirm}`);
  assert(confirm.includes(".mcp.json") && !confirm.includes("~/.claude.json"), "the confirmation names the project's .mcp.json");
  await bridge.screenshot(join(evidenceDir, "02-confirm-remove.png"));
  await bridge.clickWhenReady(`return e2e.click(e2e.must(${row("proj-docs")}?.querySelector(".mcp-action-confirm"), "yes, remove"));`);
  const deadline = Date.now() + 10_000;
  let after = null;
  while (Date.now() < deadline) {
    after = JSON.parse(readFileSync(projectMcp, "utf8"));
    if (!after.mcpServers?.["proj-docs"]) break;
    await sleep(100);
  }
  log(`  project .mcp.json servers: ${JSON.stringify(Object.keys(after?.mcpServers ?? {}))}`);
  assert(after && !after.mcpServers?.["proj-docs"], "proj-docs is gone from the project's .mcp.json");
  await bridge.waitFor("the proj-docs row to go away", `return !${row("proj-docs")};`, { timeoutMs: 10_000 });
  assert(await bridge.eval(`return !!${row("user-wide")};`), "user-wide is still listed");
  await bridge.settle();
  await bridge.screenshot(join(evidenceDir, "03-removed.png"));

  log("step 6: the user config was never written");
  if (userConfig) {
    assert(existsSync(userConfig) && Buffer.compare(readFileSync(userConfig), userBefore) === 0, "~/.claude.json is byte-identical");
  } else {
    log("  (Windows: the user config is the runner's own; the scenario does not write it)");
  }
});

#!/usr/bin/env node
// Scenario (N11): the first-launch "AI tools" screen tells a user without
// Gemini or Copilot installed how to get the tools their vendors ship today:
// Antigravity CLI (Gemini CLI's successor) and the npm Copilot CLI (the
// gh-copilot extension is retired).
//
// The test machine may have these tools installed, so the app's "is it
// installed?" check is answered with "no" for every tool, the way it answers
// on a machine without them. Everything else is the real app.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N11-install-hints.mjs

import { join } from "node:path";
import { launchApp } from "../harness.mjs";
import { completeOnboarding, runScenario } from "../n11-steps.mjs";

await runScenario("N11-install-hints", async ({ evidenceDir, log, assert, apps }) => {
  log("step 1: launch the test app with a private home folder");
  const app = await launchApp({ runDir: join(evidenceDir, "run"), log });
  apps.push(app);
  const { bridge } = app;

  let cards = [];
  await completeOnboarding(bridge, log, {
    onAiStep: async () => {
      log("step 2: answer the app's CLI check with 'not installed' for every tool");
      // The app's backend calls travel as requests to ipc://localhost/<command>;
      // rewrite only the answer to the CLI check, keeping its tool list.
      const patched = await bridge.eval(`
        const original = window.fetch;
        window.fetch = async (input, init) => {
          const res = await original(input, init);
          if (!String(input?.url ?? input).endsWith("/check_ai_providers")) return res;
          const found = await res.clone().json();
          const none = Object.fromEntries(Object.keys(found).map((id) => [id, false]));
          return new Response(JSON.stringify(none), { status: res.status, headers: res.headers });
        };
        return await window.__TAURI_INTERNALS__.invoke("check_ai_providers");
      `);
      assert(
        Object.keys(patched).length > 0 && Object.values(patched).every((v) => v === false),
        `the CLI check now reports every tool as missing: ${JSON.stringify(patched)}`,
      );
    },
    onAiScreen: async () => {
      log("step 3: read the AI tools screen");
      cards = await bridge.waitFor("the AI tools screen with install hints", `
        const cards = e2e.all(".onboarding-ai-card");
        if (cards.length === 0 || !cards.some((c) => c.querySelector(".onboarding-ai-install-cmd"))) return null;
        return cards.map((c) => ({
          name: c.querySelector(".onboarding-ai-card-name")?.innerText.trim(),
          desc: c.querySelector(".onboarding-ai-card-desc")?.innerText.trim(),
          install: c.querySelector(".onboarding-ai-install-cmd")?.innerText.trim() ?? null,
        }));
      `);
      for (const c of cards) log(`  ${c.name}: ${c.desc} — install: ${c.install}`);
      const shot = await bridge.screenshot(join(evidenceDir, "01-ai-tools-install-hints.png"));
      log(`  screenshot saved: ${shot.file}`);
    },
  });

  const gemini = cards.find((c) => c.name === "Gemini");
  const copilot = cards.find((c) => c.name === "Copilot");
  assert(!!gemini && !!copilot, "the screen lists Gemini and Copilot");
  assert(
    gemini.install === "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    "Gemini's hint installs Antigravity CLI",
  );
  assert(/Antigravity/.test(gemini.desc), `Gemini's card names its successor: "${gemini.desc}"`);
  assert(copilot.install === "npm install -g @github/copilot", "Copilot's hint installs the Copilot CLI from npm");
  assert(
    !cards.some((c) => /gh extension install|@google\/gemini-cli/.test(c.install ?? "")),
    "no card suggests a retired install command",
  );
});

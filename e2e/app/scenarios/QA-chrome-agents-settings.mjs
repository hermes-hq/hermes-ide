#!/usr/bin/env node
// Scenario QA-chrome-agents-settings: Settings > Agents, the keyboard and
// the account list, with fake `claude` and `codex` CLIs (tools/fake-agents)
// and a throwaway repository. No real account.
//
//   1. SOLO-12/17 presets: Esc while renaming cancels the rename only
//      (Settings stays open, the old name is back, the keyboard is on
//      Rename); a refused name shows its error, and the next good rename
//      (Enter) clears it.
//   2. ACC-07 names: an account name already taken ("work" after "Work",
//      "Default") is refused inline before anything is created, and by the
//      backend too; Esc in the name field closes only the form.
//   3. ACC-13c: a model the default profile refused reads "1 refused by the
//      default profile".
//   4. ACC-08 remove: Remove asks first and says what stays on disk; Esc
//      cancels and gives the keyboard back to Remove; "Remove and sign
//      out" runs the CLI's own sign-out in the profile, which stays on
//      disk; adding the name again says it reuses the existing profile.
//
// Negative control (must end in RESULT: FAIL): a build of main before the
// fix (Esc closes Settings, "work" is accepted, Remove acts at once).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/QA-chrome-agents-settings.mjs

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { skipScenario, sleep } from "../harness.mjs";
import { closeSettings, completeOnboarding, invoke, launch, launchWithChoice, openAgentsSettings, registryPath, removeWork, setFake, setupFakes } from "../cap-steps.mjs";
import { runScenario } from "../n11-steps.mjs";

const SCENARIO = "QA-chrome-agents-settings";

/** A value typed into an input, as typing does. */
const typeInto = (bridge, selector, value) =>
  bridge.eval(`
    const el = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
    el.focus();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value;
  `);

/** A key on whatever has the keyboard. */
const press = (bridge, key) =>
  bridge.eval(`
    const t = document.activeElement || document.body;
    t.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)}, bubbles: true, cancelable: true, composed: true, view: window }));
    t.dispatchEvent(new KeyboardEvent("keyup", { key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)}, bubbles: true, cancelable: true, composed: true, view: window }));
    return true;
  `);

const settingsOpen = (bridge) => bridge.exists('[role="dialog"] .settings-title');

await runScenario(SCENARIO, async ({ evidenceDir, log, apps, onCleanup }) => {
  const f = setupFakes("qa-agents", ["claude", "codex"]);
  onCleanup(() => removeWork(f, log));
  const restorePath = registryPath(f, log);
  if (restorePath === null) {
    skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows outside CI (the fakes need the registry Path)", log });
  }
  onCleanup(() => restorePath?.());
  setFake(f, "version", "claude", "2.1.284");
  setFake(f, "version", "codex", "0.145.0");

  const problems = [];
  const check = (ok, message) => {
    log(`  ${ok ? "ok" : "FAILED"} — ${message}`);
    if (!ok) problems.push(message);
  };

  const app = await launch(f, evidenceDir, log, 1, { first: true });
  apps.push(app);
  const { bridge } = app;
  await completeOnboarding(bridge);
  await invoke(bridge, "create_project", { path: f.repo, name: null });

  // ─── 1. presets ────────────────────────────────────────────────────
  log("step 1: Esc while renaming a preset cancels the rename only");
  const base = (await invoke(bridge, "get_usual_launch_choice", { repo: f.repo })).choice;
  const quick = await invoke(bridge, "save_launch_preset", { name: "Quick fix", choice: base });
  await invoke(bridge, "save_launch_preset", { name: "Plan first", choice: { ...base, approvalModeId: "plan" } });
  await openAgentsSettings(bridge);
  const row = `.agents-settings-preset[data-preset-id="${quick.id}"]`;
  await bridge.click(`${row} .agents-settings-preset-rename`);
  await bridge.waitFor("the rename field", `return !!e2e.first('${row} .agents-settings-preset-name-input');`);
  await typeInto(bridge, `${row} .agents-settings-preset-name-input`, "Abandoned name");
  await press(bridge, "Escape");
  await sleep(500);
  const afterEsc = await bridge.eval(`
    const row = e2e.first('${row}');
    return {
      settings: !!e2e.first('[role="dialog"] .settings-title'),
      editing: !!row?.querySelector(".agents-settings-preset-name-input"),
      name: e2e.norm(row?.querySelector(".agents-settings-preset-name")?.innerText ?? ""),
      focusOnRename: !!document.activeElement?.matches?.('${row} .agents-settings-preset-rename'),
    };
  `);
  log(`  after Esc: ${JSON.stringify(afterEsc)}`);
  check(afterEsc.settings, "Esc in the rename field leaves Settings open");
  check(!afterEsc.editing && afterEsc.name === "Quick fix", "the rename is cancelled and the old name is shown");
  check(afterEsc.focusOnRename, "the keyboard is back on Rename");

  if (afterEsc.settings) {
    log("  a refused name, then a good one: the error goes away");
    await bridge.click(`${row} .agents-settings-preset-rename`);
    await bridge.waitFor("the rename field", `return !!e2e.first('${row} .agents-settings-preset-name-input');`);
    await typeInto(bridge, `${row} .agents-settings-preset-name-input`, "   ");
    await press(bridge, "Enter");
    const err = await bridge
      .waitFor("the rename error", `return e2e.norm(e2e.first('${row} .agents-settings-error')?.innerText ?? "") || false;`, { timeoutMs: 5_000 })
      .catch(() => "");
    check(!!err, `an empty name is refused with a reason ("${err}")`);
    await typeInto(bridge, `${row} .agents-settings-preset-name-input`, "Quick fix 2");
    await press(bridge, "Enter");
    await bridge.waitFor("the new name", `return e2e.norm(e2e.first('${row} .agents-settings-preset-name')?.innerText ?? "") === "Quick fix 2";`, { timeoutMs: 10_000 }).catch(() => {});
    const afterSave = await bridge.eval(`return { settings: !!e2e.first('[role="dialog"] .settings-title'), error: e2e.norm(e2e.first('${row} .agents-settings-error')?.innerText ?? ""), name: e2e.norm(e2e.first('${row} .agents-settings-preset-name')?.innerText ?? "") };`);
    log(`  after a good rename: ${JSON.stringify(afterSave)}`);
    check(afterSave.name === "Quick fix 2" && afterSave.settings, "Enter saves the rename and Settings stays open");
    check(afterSave.error === "", "the earlier error is gone after the rename worked");
  }
  await bridge.screenshot(join(evidenceDir, "01-presets.png"));
  if (!(await settingsOpen(bridge))) await openAgentsSettings(bridge);

  // ─── 2. names that are taken ───────────────────────────────────────
  log("step 2: an account name that is taken is refused");
  const work = await invoke(bridge, "add_agent_account", { agentId: "claude", label: "Work" });
  log(`  added Work: ${JSON.stringify({ id: work.account.id, reused: work.reused })}`);
  await closeSettings(bridge);
  await openAgentsSettings(bridge);
  const card = '.agents-settings-card[data-agent-id="claude"]';
  for (const name of ["work", "Default"]) {
    await bridge.click(`${card} .agents-settings-add`);
    await bridge.waitFor("the account name field", `return !!e2e.first('${card} .agents-settings-add-name');`);
    await typeInto(bridge, `${card} .agents-settings-add-name`, name);
    await sleep(200);
    const state = await bridge.eval(`
      const c = e2e.first('${card}');
      return {
        disabled: !!c.querySelector(".agents-settings-add-confirm")?.disabled,
        error: e2e.norm(c.querySelector(".agents-settings-add-error, [role=alert]")?.innerText ?? ""),
      };
    `);
    log(`  "${name}": ${JSON.stringify(state)}`);
    check(state.disabled, `"${name}" cannot be added`);
    check(/^You already have a Claude Code account named /.test(state.error), `"${name}" says the name is taken ("${state.error}")`);
    await press(bridge, "Escape");
    await sleep(300);
    const closedForm = await bridge.eval(`return { form: !!e2e.first('${card} .agents-settings-add-name'), settings: !!e2e.first('[role="dialog"] .settings-title') };`);
    check(!closedForm.form && closedForm.settings, `Esc closes the name field only (${JSON.stringify(closedForm)})`);
    if (!closedForm.settings) await openAgentsSettings(bridge);
  }
  const backend = await invoke(bridge, "add_agent_account", { agentId: "claude", label: " WORK " }).then(
    (r) => ({ ok: true, id: r.account.id }),
    (e) => ({ ok: false, error: String(e) }),
  );
  log(`  backend, " WORK ": ${JSON.stringify(backend)}`);
  check(!backend.ok && /already have a Claude Code account named Work/.test(backend.error), "the backend refuses the same name in another case");
  const ids = (await invoke(bridge, "get_agent_capabilities", { agentId: "claude", accountId: null, refresh: false })).accounts.map((a) => a.id);
  check(ids.join(",") === "default,work", `one Work account only (${ids.join(",")})`);
  await bridge.screenshot(join(evidenceDir, "02-taken-name.png"));

  // ─── 3. refused by the default profile ─────────────────────────────
  log("step 3: a refused model is counted for the default profile");
  await closeSettings(bridge);
  setFake(f, "reject-models", "claude", "opus");
  const refused = await launchWithChoice(bridge, { agentId: "claude", cwd: f.repo, task: "refused here", modelId: "opus" });
  await bridge.waitFor("the refusal banner", `return !!e2e.first('.launch-rejected[data-session-id="${refused}"]');`, { timeoutMs: 40_000 });
  setFake(f, "reject-models", "claude", "");
  await openAgentsSettings(bridge);
  const models = await bridge.eval(`return e2e.norm(e2e.first('${card} .agents-settings-models')?.innerText ?? "");`);
  log(`  Claude models: "${models}"`);
  check(models.endsWith("· 1 refused by the default profile"), `the line says who refused it ("${models}")`);

  // ─── 4. remove ─────────────────────────────────────────────────────
  log("step 4: Remove asks first; Remove and sign out signs the profile out and keeps it");
  const profile = work.account.profileEnv.value;
  // Signed in on disk (as its CLI's own sign-in does); Check again reads it.
  writeFileSync(join(profile, ".fake-auth"), "in\n");
  await bridge.click(".agents-settings-refresh");
  const acct = `${card} .agents-settings-account[data-account-id="work"]`;
  await bridge.waitFor("Work signed in", `return e2e.first('${acct}')?.dataset.signedIn === "signed-in";`, { timeoutMs: 30_000 }).catch(() => {});
  await bridge.click(`${acct} .agents-settings-remove`).catch(async () => {
    await bridge.eval(`const row = e2e.first('${acct}'); e2e.click([...row.querySelectorAll("button")].find((b) => /Remove/.test(b.innerText))); return true;`);
  });
  // Either a confirmation shows, or (before the fix) the row goes once the
  // backend removed it and the list was read again.
  await bridge
    .waitFor("a confirmation or the row to go", `return !!e2e.first('${acct} [role="alertdialog"]') || !e2e.first('${acct}');`, { timeoutMs: 20_000 })
    .catch(() => {});
  const asked = await bridge.eval(`
    const c = e2e.first('${acct} [role="alertdialog"]');
    return { row: !!e2e.first('${acct}'), text: e2e.norm(c?.innerText ?? ""), buttons: c ? [...c.querySelectorAll("button")].map((b) => e2e.norm(b.innerText)) : [] };
  `);
  log(`  after one click on Remove: ${JSON.stringify(asked)}`);
  check(asked.row, "one click on Remove does not remove the account");
  check(/^Remove Work from Hermes\? Its profile folder .+ stays on this (Mac|computer) and is still signed in\./.test(asked.text), "the confirmation says the folder stays and is still signed in");
  check(asked.buttons.includes("Remove") && asked.buttons.includes("Remove and sign out"), `it offers Remove and Remove and sign out (${asked.buttons.join(", ")})`);
  await bridge.screenshot(join(evidenceDir, "03-remove-confirm.png"));
  if (asked.text) {
    await press(bridge, "Escape");
    await sleep(400);
    const afterEsc2 = await bridge.eval(`return { confirm: !!e2e.first('${acct} [role="alertdialog"]'), row: !!e2e.first('${acct}'), settings: !!e2e.first('[role="dialog"] .settings-title'), focus: document.activeElement === e2e.first('${acct} .agents-settings-remove') };`);
    check(!afterEsc2.confirm && afterEsc2.row && afterEsc2.settings, `Esc cancels the removal only (${JSON.stringify(afterEsc2)})`);
    check(afterEsc2.focus, "after Esc the keyboard is back on that account's Remove");
    await bridge.click(`${acct} .agents-settings-remove`);
    await bridge.waitFor("the confirmation", `return !!e2e.first('${acct} .agents-settings-confirm-sign-out');`);
    await bridge.click(`${acct} .agents-settings-confirm-sign-out`);
    await bridge.waitFor("Work to go", `return !e2e.first('${acct}');`, { timeoutMs: 30_000 }).catch(() => {});
  }
  const gone = !(await bridge.exists(acct));
  check(gone, "Remove and sign out removes the account");
  check(existsSync(profile), "its profile folder stays on disk");
  const auth = existsSync(join(profile, ".fake-auth")) ? readFileSync(join(profile, ".fake-auth"), "utf8").trim() : "";
  const logout = readdirSync(f.recordDir).filter((n) => n.startsWith("logout-")).map((n) => JSON.parse(readFileSync(join(f.recordDir, n), "utf8")));
  log(`  profile auth now "${auth}"; sign-outs: ${JSON.stringify(logout.map((l) => ({ argv: l.argv, profile: l.profileDir === profile })))}`);
  check(auth === "out" && logout.some((l) => l.argv.join(" ") === "auth logout" && l.profileDir === profile), "the CLI's own sign-out ran in that profile");

  log("  adding Work again says it reuses the folder");
  writeFileSync(join(profile, ".fake-auth"), "in\n");
  await bridge.click(`${card} .agents-settings-add`);
  await bridge.waitFor("the account name field", `return !!e2e.first('${card} .agents-settings-add-name');`);
  await typeInto(bridge, `${card} .agents-settings-add-name`, "Work");
  await bridge.click(`${card} .agents-settings-add-confirm`);
  const notice = await bridge
    .waitFor("the reuse notice", `return e2e.norm(e2e.first('${card} .agents-settings-notice')?.innerText ?? "") || false;`, { timeoutMs: 30_000 })
    .catch(() => "");
  log(`  notice: "${notice}"`);
  check(/^Using the existing profile .+ \(already signed in\)$/.test(notice), "re-adding says it uses the existing, signed-in profile");
  await bridge.screenshot(join(evidenceDir, "04-reused.png"));

  if (problems.length) throw new Error(`${problems.length} check(s) failed:\n  - ${problems.join("\n  - ")}`);
});

#!/usr/bin/env node
// HOD-for-you-react: the Library's first screen fits the project the person
// is in, worked out on the device from the project's files.
//
//   - A TypeScript + React project (package.json with react and
//     typescript, tsconfig.json, src/App.tsx, a .claude folder) is open in
//     the focused terminal. The Library's "For this project" shelf names the
//     stack ("react-app uses TypeScript, React"), leads with entries for
//     that stack, and each of those cards says why ("Your project uses
//     React").
//   - The focused terminal moves to a Python project: the shelf follows
//     (Python entries lead, the reason names Python).
//   - "Show everything" turns personalisation off: no personal shelves, no
//     reasons, plain quality order. Turning it back on restores them.
//   - Nothing about the project is sent anywhere: the mirror URL points at a
//     local server that records every request. The only requests allowed
//     are the background update check's catalog manifest and signature,
//     the same two files for everyone.
//
// Negative control: HERMES_E2E_HOD_NEGATIVE=plain gives the "React" project
// no package.json or tsconfig.json; the stack checks must then fail.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";
import { catalogServer, closeLibrary, invoke, libraryState, openLibrary } from "../library-steps.mjs";

const NAME = "HOD-for-you-react";
const NEGATIVE = process.env.HERMES_E2E_HOD_NEGATIVE === "plain";
const mirror = await catalogServer();

function projects(work) {
  const react = join(work, "react-app");
  mkdirSync(join(react, "src"), { recursive: true });
  mkdirSync(join(react, ".claude"), { recursive: true });
  if (!NEGATIVE) {
    writeFileSync(
      join(react, "package.json"),
      JSON.stringify({ name: "react-app", private: true, dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" }, devDependencies: { typescript: "^5.6.0", vite: "^6.0.0" } }, null, 2),
    );
    writeFileSync(join(react, "tsconfig.json"), JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2));
  }
  writeFileSync(join(react, "src", "App.tsx"), "export function App() {\n  return <h1>Hello</h1>;\n}\n");
  const py = join(work, "py-app");
  mkdirSync(py, { recursive: true });
  writeFileSync(join(py, "pyproject.toml"), '[project]\nname = "py-app"\nversion = "0.1.0"\ndependencies = ["requests"]\n');
  writeFileSync(join(py, "main.py"), "print('hello')\n");
  writeFileSync(join(py, "requirements.txt"), "requests==2.32.0\n");
  return { react, py };
}

async function terminalIn(bridge, label, cwd) {
  const id = await bridge.eval(`return await window.__HERMES_E2E__.newTerminal(${JSON.stringify({ label, cwd })});`, { timeoutMs: 30_000 });
  if (!id) throw new Error(`no terminal for ${label}`);
  await bridge.waitFor(`the ${label} terminal`, `const i = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(id)}); return !!i && i.opened;`, { timeoutMs: 30_000 });
  return id;
}

const projectShelf = (st) => st.shelves.find((s) => s.id === "project") ?? null;

try {
  await runLauncherQa(
    NAME,
    async ({ bridge, fx, log, check, evidenceDir }) => {
      const { react, py } = projects(fx.work);
      await terminalIn(bridge, "react-app", react);
      await sleep(800);
      await openLibrary(bridge);
      await bridge.waitFor("the project shelf", `return !!e2e.first('.lib-shelf[data-shelf="project"] .lib-card');`, { timeoutMs: 20_000 }).catch(() => null);
      const st = await libraryState(bridge);
      await bridge.screenshot(join(evidenceDir, "01-for-you-react.png"));
      const shelf = projectShelf(st);
      log(`  shelves: ${st.shelves.map((s) => s.id).join(", ")}`);
      log(`  project shelf: ${shelf ? `"${shelf.why}" -> ${shelf.cards.map((c) => `${c.id}[${c.reasons.join("+")}]`).join(", ")}` : "none"}`);
      check(st.personalised === "true", "the home screen is personalised");
      check(st.shelves[0]?.id === "project", "the first shelf is For this project");
      check(!!shelf && /TypeScript/.test(shelf.why) && /React/.test(shelf.why), `it names the project's stack ("${shelf?.why ?? ""}")`);
      const lead = shelf?.cards.slice(0, 3) ?? [];
      const rows = [];
      for (const c of lead) rows.push((await invoke(bridge, "library_get", { id: c.id })).row);
      log(`  leading entries' stacks: ${rows.map((r) => `${r.id}:${(r.stack ?? []).join("/")}`).join(", ")}`);
      check(
        rows.length === 3 && rows.every((r) => (r.stack ?? []).some((s) => ["typescript", "react", "javascript"].includes(s))),
        "it leads with TypeScript / React / JavaScript entries",
      );
      check(
        lead.every((c) => c.reasons.includes("stack")) && lead.some((c) => /React|TypeScript/.test(c.why)),
        `each of them says why ("${lead[0]?.why ?? ""}")`,
      );

      // The focused terminal moves to a Python project.
      await closeLibrary(bridge);
      await terminalIn(bridge, "py-app", py);
      await sleep(800);
      await openLibrary(bridge);
      await bridge.waitFor("the Python project shelf", `const s = e2e.first('.lib-shelf[data-shelf="project"] .lib-shelf-why'); return !!s && /Python/.test(s.innerText);`, { timeoutMs: 20_000 }).catch(() => null);
      const pySt = await libraryState(bridge);
      const pyShelf = projectShelf(pySt);
      await bridge.screenshot(join(evidenceDir, "02-for-you-python.png"));
      log(`  python shelf: ${pyShelf ? `"${pyShelf.why}" -> ${pyShelf.cards.map((c) => c.id).join(", ")}` : "none"}`);
      const pyFirst = pyShelf?.cards[0] ? (await invoke(bridge, "library_get", { id: pyShelf.cards[0].id })).row : null;
      check(!!pyShelf && /Python/.test(pyShelf.why) && !/React/.test(pyShelf.why), "in a Python project the shelf names Python instead");
      check(!!pyFirst && (pyFirst.stack ?? []).includes("python"), `and leads with a Python entry (${pyFirst?.id})`);

      // Show everything: no personal shelves, no reasons.
      await bridge.click(".lib-show-everything");
      await bridge.waitFor("plain quality order", `return e2e.first(".lib-context")?.getAttribute("data-personalised") === "false";`, { timeoutMs: 15_000 });
      await sleep(300);
      const plain = await libraryState(bridge);
      await bridge.screenshot(join(evidenceDir, "03-show-everything.png"));
      log(`  show everything: ${plain.shelves.map((s) => `${s.id}(${s.cards.length})`).join(", ")}`);
      check(!plain.shelves.some((s) => s.id === "project" || s.id === "role"), "Show everything drops the personal shelves");
      check(plain.shelves.every((s) => s.cards.every((c) => c.reasons.length === 0)), "and every reason");
      await bridge.click(".lib-show-everything");
      await bridge.waitFor("personalised again", `return e2e.first(".lib-context")?.getAttribute("data-personalised") === "true";`, { timeoutMs: 15_000 });
      check(projectShelf(await libraryState(bridge)) !== null, "turning it back on brings the project shelf back");

      const asked = mirror.hits.filter((h) => !/^manifest\.json(\.minisig)?$/.test(h));
      log(`  mirror requests: ${JSON.stringify(mirror.hits)}`);
      check(asked.length === 0, `nothing about the project was sent (${mirror.hits.length} requests, all for the catalog manifest)`);
    },
    { env: { HERMES_E2E_LIBRARY_URL: mirror.url, HERMES_LIBRARY_FIRST_CHECK_SECS: "1" }, tag: "hod-foryou" },
  );
} finally {
  await mirror.close();
}

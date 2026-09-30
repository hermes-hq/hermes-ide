import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stylelint from "stylelint";
import { addedLines, lintChangedCss } from "./lint-css.mjs";

const CONFIG = new URL("../.stylelintrc.json", import.meta.url).pathname;

async function lintCode(code, codeFilename = "src/styles/ui/sample.css") {
  const { results } = await stylelint.lint({ code, codeFilename, configFile: CONFIG });
  return results[0].warnings.map((w) => w.rule);
}

describe("stylesheet rules (docs/design-system/09-migration.md)", () => {
  it.each([
    ["raw px", ".a { padding: 5px; }", "unit-disallowed-list"],
    ["hex colour", ".a { color: #fff; }", "color-no-hex"],
    ["named colour", ".a { color: white; }", "color-named"],
    ["rgba()", ".a { background: rgba(0, 0, 0, 0.2); }", "function-disallowed-list"],
    ["outline: none", ".a:focus-visible { outline: none; }", "declaration-property-value-disallowed-list"],
    ["raw weight", ".a { font-weight: 600; }", "declaration-property-value-disallowed-list"],
    ["hand-rolled shadow", ".a { box-shadow: 0 4px 12px var(--shadow-tint); }", "declaration-property-value-allowed-list"],
    ["hand-rolled easing", ".a { transition: opacity 200ms cubic-bezier(0.16, 1, 0.3, 1); }", "declaration-property-value-disallowed-list"],
  ])("rejects %s", async (_what, code, rule) => {
    expect(await lintCode(code)).toContain(rule);
  });

  it("accepts the token way of writing the same things", async () => {
    const code = `.a {
  padding: 0 var(--control-px-md);
  color: var(--text-1);
  background: color-mix(in srgb, var(--primary-bg) 16%, transparent);
  font-weight: var(--control-weight);
  box-shadow: var(--shadow-1);
  transition: opacity var(--dur-quick) var(--ease-out-soft);
  outline: var(--focus-ring-width) solid var(--focus-ring);
}`;
    expect(await lintCode(code)).toEqual([]);
  });

  it("leaves tokens.css and themes.css alone (raw values belong there)", async () => {
    const { results } = await stylelint.lint({ code: ":root { --x: #fff; --y: 4px; }", codeFilename: "src/styles/tokens.css", configFile: CONFIG });
    expect(results[0].ignored).toBe(true);
  });
});

describe("added lines of a diff", () => {
  it("reads the new-file line numbers of every hunk", () => {
    const diff = "@@ -3,0 +4,2 @@\n+a\n+b\n@@ -10 +12 @@\n-x\n+y\n@@ -20,3 +23,0 @@\n-gone\n";
    expect([...addedLines(diff)].sort((a, b) => a - b)).toEqual([4, 5, 12]);
  });
});

describe("baseline: old lines are allowed, new lines and new files are strict", () => {
  let repo;
  const run = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "hermes-lint-css-"));
    run("init", "-q", "-b", "main");
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");
    mkdirSync(join(repo, "src/styles/components"), { recursive: true });
    mkdirSync(join(repo, "src/styles/ui"), { recursive: true });
    // An older stylesheet with violations already in it.
    writeFileSync(join(repo, "src/styles/components/Old.css"), ".old {\n  padding: 5px;\n  color: #123456;\n}\n");
    writeFileSync(join(repo, "src/styles/ui/kit.css"), ".k { color: var(--text-0); }\n");
    run("add", "-A");
    run("commit", "-q", "-m", "base");
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("a change that touches nothing is clean, even with old violations in the file", async () => {
    const { problems } = await lintChangedCss({ cwd: repo, base: "main", configFile: CONFIG });
    expect(problems).toEqual([]);
  });

  it("flags only the new line of an older stylesheet, and every line of a new one and of src/styles/ui", async () => {
    writeFileSync(join(repo, "src/styles/components/Old.css"), ".old {\n  padding: 5px;\n  color: #123456;\n  outline: none;\n  gap: var(--space-2);\n}\n");
    writeFileSync(join(repo, "src/styles/components/New.css"), ".new { margin: 3px; }\n");
    writeFileSync(join(repo, "src/styles/ui/kit.css"), ".k { color: var(--text-0); }\n.k2 { color: #000; }\n");
    const { problems } = await lintChangedCss({ cwd: repo, base: "main", configFile: CONFIG });
    const at = problems.map((p) => `${p.file}:${p.line}:${p.rule}`).sort();
    expect(at).toEqual([
      "src/styles/components/New.css:1:unit-disallowed-list",
      "src/styles/components/Old.css:4:declaration-property-value-disallowed-list",
      "src/styles/ui/kit.css:2:color-no-hex",
    ]);
  });

  it("holds the stylesheet of a screen moved to the control set to every line, even untouched", async () => {
    // Old.css already had its violations at the base commit; as a migrated screen's sheet it is strict.
    run("checkout", "-q", "--", ".");
    run("clean", "-qfd");
    const loose = await lintChangedCss({ cwd: repo, base: "main", configFile: CONFIG, strictFiles: [] });
    expect(loose.problems).toEqual([]);
    const strict = await lintChangedCss({ cwd: repo, base: "main", configFile: CONFIG, strictFiles: ["src/styles/components/Old.css"] });
    expect(strict.problems.map((p) => `${p.file}:${p.line}:${p.rule}`).sort()).toEqual([
      "src/styles/components/Old.css:2:unit-disallowed-list",
      "src/styles/components/Old.css:3:color-no-hex",
    ]);
  });
});

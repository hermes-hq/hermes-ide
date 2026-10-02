import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import allowlist from "../../eslint-rules/untranslated-strings.allowlist.json";

// Runs the repository's real ESLint config against small snippets, so this
// proves what `npx eslint .` does in CI — not what the rule file says.

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RULE = "hermes/no-untranslated-strings";

// The allowlist may only shrink. Lower this when a file is fixed; never raise it.
const ALLOWLIST_CEILING = 74;

async function lint(code: string, filePath: string, eslint = new ESLint({ cwd: REPO_ROOT })) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.ruleId === RULE);
}

const NEW_COMPONENT = "src/components/SomeNewSurface.tsx";

describe("no-untranslated-strings lint rule", () => {
  it("flags a hardcoded sentence in JSX text in a new surface", async () => {
    const code = `export function X() { return <span>Waiting for approval</span>; }`;
    const messages = await lint(code, NEW_COMPONENT);
    expect(messages).toHaveLength(1);
    expect(messages[0].severity).toBe(2);
    expect(messages[0].message).toContain('t("...")');
  });

  it.each([
    { attr: "title", code: 'export function X({ t }) { return <button title="Copy to clipboard" />; }' },
    { attr: "aria-label", code: 'export function X({ t }) { return <input aria-label="Search files" />; }' },
    { attr: "placeholder", code: 'export function X({ t }) { return <input placeholder="Type a command" />; }' },
    { attr: "alt", code: 'export function X({ t }) { return <img alt="Session avatar" />; }' },
  ])("flags a hardcoded $attr attribute", async ({ code }) => {
    const messages = await lint(code, NEW_COMPONENT);
    expect(messages.length).toBeGreaterThan(0);
  });

  it("known gap: a string literal inside {…} is not flagged", async () => {
    // The rule reads only literal JSX text and the fixed attribute list,
    // never expressions — so `{"Some text"}`, template literals and other
    // attributes slip through. Kept as a test so the gap is visible, not
    // mistaken for coverage.
    const code = `export function X() { return <div>{"Multiple words here"}</div>; }`;
    expect(await lint(code, NEW_COMPONENT)).toEqual([]);
  });

  it("allows text already routed through t()", async () => {
    const code = `export function X({ t }) { return <span>{t("status.working")}</span>; }`;
    expect(await lint(code, NEW_COMPONENT)).toEqual([]);
  });

  it("allows vendor-reported runtime values (a model name from a variable, not a literal)", async () => {
    const code = `export function X({ model }: { model: string }) { return <span>{model}</span>; }`;
    expect(await lint(code, NEW_COMPONENT)).toEqual([]);
  });

  it("allows short glyphs, punctuation and numbers", async () => {
    const code = `export function X() { return <span>{"x"}· / 42% $12.34</span>; }`;
    expect(await lint(code, NEW_COMPONENT)).toEqual([]);
  });

  it("does not apply outside .tsx files", async () => {
    const code = `export const s = "Waiting for approval";`;
    expect(await lint(code, "src/utils/not-a-component.ts")).toEqual([]);
  });

  it("does not apply to test files", async () => {
    const code = `export function X() { return <span>Waiting for approval</span>; }`;
    expect(await lint(code, "src/__tests__/some-new-feature.test.tsx")).toEqual([]);
  });

  it("exempts files on the allowlist", async () => {
    const code = `export function X() { return <span>Waiting for approval</span>; }`;
    expect(await lint(code, allowlist.files[0])).toEqual([]);
  });
});

describe("untranslated-strings allowlist", () => {
  it("only shrinks", () => {
    expect(allowlist.files.length).toBeLessThanOrEqual(ALLOWLIST_CEILING);
    expect(new Set(allowlist.files).size).toBe(allowlist.files.length);
  });

  it("has no stale entries: every listed file still exists and still hardcodes text", async () => {
    const strict = new ESLint({
      cwd: REPO_ROOT,
      overrideConfig: { rules: { [RULE]: ["error", { allowlist: [] }] } },
    });
    const results = await strict.lintFiles(allowlist.files);
    const stale = results.filter((r) => !r.messages.some((m) => m.ruleId === RULE)).map((r) => r.filePath);
    expect(results).toHaveLength(allowlist.files.length);
    expect(stale, "these files no longer hardcode text — remove them from the allowlist").toEqual([]);
  }, 60_000);

  it("lists no test files (tests are out of the rule's scope entirely)", () => {
    expect(allowlist.files.filter((f) => /\.test\.tsx$|__tests__/.test(f))).toEqual([]);
  });
});

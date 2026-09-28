// Minimal ESLint flat config — focused on catching the class of bug
// that shipped in 1.1.7/1.1.8: hooks called conditionally or after an
// early return (React error #310).
//
// Scope is intentionally narrow.  We do NOT enable general TS/React
// stylistic rules here — that would surface hundreds of pre-existing
// findings in unrelated files and slow the preflight loop.  The single
// goal is: prevent another silent hook-order regression.
//
// If you want to expand the ruleset, do it as a separate change with
// triage of existing findings.

import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import { readFileSync } from "node:fs";
import noSourceReadingTests from "./eslint-rules/no-source-reading-tests.js";
import noVendorIdChecks from "./eslint-rules/no-vendor-id-checks.js";
import noUntranslatedStrings from "./eslint-rules/no-untranslated-strings.js";

// Existing tests that read files. The list may only shrink.
const sourceReadingAllowlist = JSON.parse(
  readFileSync(new URL("./eslint-rules/source-reading-tests.allowlist.json", import.meta.url), "utf8"),
).files;

// Agent ids come from the catalog, so a new agent is covered automatically.
const vendorIds = JSON.parse(readFileSync(new URL("./src/catalog/agents.json", import.meta.url), "utf8"))
  .agents.map((a) => a.id)
  .filter((id) => id !== "custom");
// Files that branched on an agent id before the rule existed. May only shrink.
const vendorIdAllowlist = JSON.parse(
  readFileSync(new URL("./eslint-rules/vendor-id-checks.allowlist.json", import.meta.url), "utf8"),
).files;

// Pre-2.0 files that already hardcode UI text. The list may only shrink —
// see eslint-rules/no-untranslated-strings.js. Every new file is held to
// the rule from day one.
const untranslatedStringsAllowlist = JSON.parse(
  readFileSync(new URL("./eslint-rules/untranslated-strings.allowlist.json", import.meta.url), "utf8"),
).files;

// One plugin object shared by every config block below: flat config
// requires the same plugin name to resolve to the same object wherever
// two blocks' `files` globs overlap (e.g. a *.test.tsx file matches both
// the untranslated-strings block and the source-reading-tests block).
const hermesPlugin = {
  rules: {
    "no-source-reading-tests": noSourceReadingTests,
    "no-untranslated-strings": noUntranslatedStrings,
  },
};

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/target/**",
      "src-tauri/bridge/node_modules/**",
      "src-tauri/test-fixtures/**",
      "build/**",
      "coverage/**",
    ],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.es2024,
      },
    },
    plugins: {
      // typescript-eslint is registered (not enabled) only so existing
      // `// eslint-disable-next-line @typescript-eslint/...` comments
      // in the codebase resolve to a known plugin namespace instead of
      // erroring as "rule definition not found".  No TS rules run.
      "@typescript-eslint": tseslint.plugin,
      "react-hooks": reactHooks,
    },
    rules: {
      // The rule that would have caught the 1.1.7/1.1.8 bug at lint time.
      "react-hooks/rules-of-hooks": "error",
      // Stale-deps warnings.  Kept at warn so a missed dependency
      // doesn't block the build, but it surfaces in PR review.
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // Vendor-neutral core (F19): only src/agent/providers may branch on an
    // agent's id. Tests may name agents freely.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}", "src/**/__tests__/**"],
    plugins: {
      "hermes-vendor": { rules: { "no-vendor-id-checks": noVendorIdChecks } },
    },
    rules: {
      "hermes-vendor/no-vendor-id-checks": ["error", { vendorIds, allowlist: vendorIdAllowlist }],
    },
  },
  {
    // 2.0: new surfaces must route user-facing text through t(), not a
    // hardcoded string (F18 — docs/adr/004-2.0-contracts.md's later
    // features build vendor-neutral, user-facing UI; a hardcoded string
    // never sees a language pack).
    // Tests aren't a UI surface a person sees, so they're out of scope —
    // not allowlisted, just not the rule's business.
    files: ["src/**/*.tsx"],
    ignores: ["src/**/*.test.tsx", "src/**/__tests__/**"],
    plugins: { hermes: hermesPlugin },
    rules: {
      "hermes/no-untranslated-strings": ["error", { allowlist: untranslatedStringsAllowlist }],
    },
  },
  {
    // Tests must exercise code, not read source text.
    files: ["src/**/*.test.{ts,tsx}", "src/**/__tests__/**/*.{ts,tsx}"],
    plugins: { hermes: hermesPlugin },
    rules: {
      "hermes/no-source-reading-tests": ["error", { allowlist: sourceReadingAllowlist }],
    },
  },
];

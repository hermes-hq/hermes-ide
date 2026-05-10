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
];

#!/usr/bin/env node
// Scenario N17 with this repo's own dependencies: the N17-fast-worktrees
// scenario, but the project folder holds this repo's package.json, lockfile
// and node_modules (tens of thousands of files, about 700 MB) instead of the
// synthetic install. It measures the acceptance criterion as written: "a new
// worktree of this repo has working dependencies in under 10 seconds", and
// the demo server loads react from the clone.
//
// Needs this repo's node_modules installed (npm ci). Same copy-on-write
// folder rules and negative control (HERMES_E2E_N17_NEGATIVE=1) as
// N17-fast-worktrees.mjs.
//
//   node e2e/app/build.mjs
//   node e2e/app/run.mjs N17-real-deps.mjs

process.env.HERMES_E2E_N17_REAL_DEPS = "1";
await import("./N17-fast-worktrees.mjs");

// Which real-app scenarios CI runs, and on which shard.
//
// Every file under e2e/app/scenarios runs in CI unless it is listed below.
// The scenario jobs split them across parallel shards by a stable hash of
// the file name, so a scenario always lands on the same shard and adding
// one never moves the others.

import { createHash } from "node:crypto";

/**
 * Scenarios the shard jobs do not run, and where they run instead.
 * `build`: in the build job, next to the Rust toolchain and the warm target
 * folder it needs. `keys`: in its own step, with real OS key presses.
 * `cow`: in its own step, once a copy-on-write volume is mounted (N17).
 */
export const CI_ELSEWHERE = {
  "N01-release-refuses-e2e.mjs": "build",
  "F05-terminal-keys.mjs": "keys",
  "F15-launcher-tab.mjs": "keys",
  "UI-focus-ring.mjs": "keys",
  "UI-launch-surfaces.mjs": "keys",
  "UI-dialogs.mjs": "keys",
  "N17-fast-worktrees.mjs": "cow",
  "N17-real-deps.mjs": "cow",
};

/** Scenarios the shard jobs never run, with the reason (not at all, or in a job of their own). */
export const CI_EXCLUDED = {
  "F25-appimage-update.mjs": "runs in the e2e-installers job (two real AppImages; see .github/workflows/ci.yml)",
  "F25-winget-install.mjs": "runs in the e2e-installers job (winget on Windows; see .github/workflows/ci.yml)",
  "N11-copilot-cli.mjs": "N11 is planned and macOS-only (see e2e/acceptance.yml)",
  "N11-install-hints.mjs": "N11 is planned and macOS-only (see e2e/acceptance.yml)",
  "N11-split-cwd-report.mjs": "N11 is planned and macOS-only (see e2e/acceptance.yml)",
  "N11-transcript-per-project.mjs": "N11 is planned and macOS-only (see e2e/acceptance.yml)",
  "N11-workbench-notes-restore.mjs": "N11 is planned and macOS-only (see e2e/acceptance.yml)",
  "REAL-claude-launch.mjs": "local only: needs a signed-in real claude and costs a turn; it says SKIP in CI",
  "REAL-models-claude.mjs": "local only: needs a signed-in real claude and costs a few tiny turns; it says SKIP in CI",
  "REAL-models-codex.mjs": "local only: needs a signed-in real codex and costs a few tiny turns; it says SKIP in CI",
  "REAL-models-agy.mjs": "local only: needs a signed-in real agy and costs a few tiny turns; it says SKIP in CI",
  "REAL-launcher-claude.mjs": "local only: needs a signed-in real claude and costs a turn; it says SKIP in CI",
  "REAL-status-claude.mjs": "local only: needs a signed-in real claude and costs a few turns; it says SKIP in CI",
  "REAL-status-codex.mjs": "local only: needs a signed-in real codex and costs a few turns; it says SKIP in CI",
  "REAL-status-agy.mjs": "local only: needs a signed-in real agy and costs a few turns; it says SKIP in CI",
};

/** The scenarios the shard jobs split between them: every file not listed above. */
export function shardedScenarios(files) {
  return files.filter((f) => !(f in CI_ELSEWHERE) && !(f in CI_EXCLUDED));
}

/** The scenarios of CI set `name`: "shards", or a place named in CI_ELSEWHERE. */
export function ciSetScenarios(files, name) {
  if (name === "shards") return shardedScenarios(files);
  const places = new Set(Object.values(CI_ELSEWHERE));
  if (!places.has(name)) throw new Error(`unknown CI set ${JSON.stringify(name)} (have: shards, ${[...places].join(", ")})`);
  return files.filter((f) => CI_ELSEWHERE[f] === name);
}

/** "2/3" → { index: 2, count: 3 }. Shards are numbered from 1. */
export function parseShard(text) {
  const m = /^(\d+)\/(\d+)$/.exec(String(text ?? "").trim());
  if (!m) throw new Error(`--shard wants K/N, like 2/3 (got ${JSON.stringify(text)})`);
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (count < 1 || index < 1 || index > count) throw new Error(`--shard ${text}: K must be between 1 and N`);
  return { index, count };
}

/** The shard (1..count) a scenario file belongs to: a hash of its name only. */
export function shardOf(file, count) {
  const digest = createHash("sha1").update(file).digest();
  return (digest.readUInt32BE(0) % count) + 1;
}

/** The files of `files` that belong to `shard`, in their original order. */
export function filesInShard(files, shard) {
  return files.filter((f) => shardOf(f, shard.count) === shard.index);
}

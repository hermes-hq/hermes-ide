#!/usr/bin/env node
// CI check: dev, test (e2e) and other non-production build configs must never
// use the production bundle identifier. A build with the production
// identifier shares the installed app's data folder, database, worktree
// journal and web storage, so one test run could wipe a user's sessions.
//
//   node scripts/check-instance-identifiers.mjs [--root <repo root>]
//
// Rules:
//   - src-tauri/tauri.conf.json sets the production identifier, and the
//     runtime guard (src-tauri/src/instance.rs) protects that same identifier.
//   - tauri.dev.conf.json and tauri.e2e.conf.json exist and set their own
//     identifier.
//   - Every other overlay (tauri.<name>.conf.json) that is not a platform
//     file Tauri merges automatically must also set its own identifier.
//   - Platform files (tauri.linux.conf.json, ...) must not change it.
//   - Tauri replaces the whole `app.windows` list when it merges an overlay,
//     so the dev and e2e overlays must repeat every window setting of
//     tauri.conf.json (only `title` may differ, and they may add settings).
//   - `npm run tauri` goes through scripts/tauri.mjs, which adds the dev
//     overlay to `tauri dev`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORM_OVERLAYS = new Set(["linux", "windows", "macos", "android", "ios"]);
const REQUIRED_OVERLAYS = ["dev", "e2e"];

/** Problems where an overlay's windows list drifted from the base one. */
function windowDrift(rel, baseWindows, overlayWindows) {
  if (!Array.isArray(baseWindows) || overlayWindows === undefined) return [];
  if (!Array.isArray(overlayWindows) || overlayWindows.length !== baseWindows.length) {
    return [`${rel}: app.windows must list the same ${baseWindows.length} window(s) as tauri.conf.json`];
  }
  const problems = [];
  baseWindows.forEach((base, i) => {
    for (const [key, value] of Object.entries(base ?? {})) {
      if (key === "title") continue;
      if (JSON.stringify(overlayWindows[i]?.[key]) !== JSON.stringify(value)) {
        problems.push(
          `${rel}: window ${i} "${key}" is ${JSON.stringify(overlayWindows[i]?.[key])}, tauri.conf.json has ${JSON.stringify(value)} (the overlay replaces the whole windows list, so copy the change)`,
        );
      }
    }
  });
  return problems;
}

function readJson(file, problems) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    problems.push(`${file}: cannot read it as JSON (${e.message})`);
    return null;
  }
}

/** Returns a list of problems; empty means the check passes. */
export function checkInstanceIdentifiers(root) {
  const problems = [];
  const tauriDir = join(root, "src-tauri");
  const base = readJson(join(tauriDir, "tauri.conf.json"), problems);
  const production = base?.identifier;
  if (!production) {
    problems.push("src-tauri/tauri.conf.json: no production identifier");
    return problems;
  }

  const guard = join(tauriDir, "src", "instance.rs");
  if (existsSync(guard)) {
    const declared = /PRODUCTION_IDENTIFIER: &str = "([^"]+)"/.exec(readFileSync(guard, "utf8"))?.[1];
    if (declared !== production) {
      problems.push(
        `src-tauri/src/instance.rs protects "${declared}" but the production identifier is "${production}"`,
      );
    }
  } else {
    problems.push("src-tauri/src/instance.rs is missing: nothing stops a test build from using production data");
  }

  const pkg = readJson(join(root, "package.json"), problems);
  if (pkg && !/scripts\/tauri\.mjs/.test(pkg.scripts?.tauri ?? "")) {
    problems.push(
      `package.json: "tauri" script must run scripts/tauri.mjs so \`npm run tauri dev\` gets the dev identifier (found "${pkg.scripts?.tauri}")`,
    );
  }

  const overlays = readdirSync(tauriDir)
    .map((name) => /^tauri\.(.+)\.conf\.json$/.exec(name)?.[1])
    .filter(Boolean);
  for (const required of REQUIRED_OVERLAYS) {
    if (!overlays.includes(required)) problems.push(`src-tauri/tauri.${required}.conf.json is missing`);
  }

  for (const name of overlays) {
    const rel = `src-tauri/tauri.${name}.conf.json`;
    const config = readJson(join(tauriDir, `tauri.${name}.conf.json`), problems);
    if (!config) continue;
    const id = config.identifier;
    if (PLATFORM_OVERLAYS.has(name)) {
      if (id !== undefined && id !== production) {
        problems.push(`${rel}: a platform file must not change the identifier (found "${id}")`);
      }
      continue;
    }
    if (typeof id !== "string" || id.length === 0) {
      problems.push(`${rel}: must set its own identifier (it would inherit the production one, "${production}")`);
    } else if (id.toLowerCase() === production.toLowerCase()) {
      problems.push(`${rel}: uses the production identifier "${production}"`);
    }
    if (REQUIRED_OVERLAYS.includes(name)) {
      problems.push(...windowDrift(rel, base.app?.windows, config.app?.windows));
    }
  }
  return problems;
}

function main() {
  const at = process.argv.indexOf("--root");
  const root = at > 0 ? resolve(process.argv[at + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const problems = checkInstanceIdentifiers(root);
  if (problems.length > 0) {
    for (const p of problems) console.error(`instance identifiers: ${p}`);
    console.error(`instance identifiers: FAILED (${problems.length} problem${problems.length === 1 ? "" : "s"})`);
    process.exit(1);
  }
  console.log("instance identifiers: OK — dev, test and beta configs never use the production identifier");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

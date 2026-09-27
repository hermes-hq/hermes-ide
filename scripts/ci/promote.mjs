// Promotion from the beta channel to stable (used by promote.yml).
//
//   node scripts/ci/promote.mjs pick   --repo owner/name [--tag vX.Y.Z] [--soak-hours 24]
//   node scripts/ci/promote.mjs canary --repo owner/name --tag vX.Y.Z
//
// `pick` prints a JSON line { tag, previous } for the prerelease that has
// soaked long enough (or the one named with --tag), or {} when there is
// nothing to promote. A release is held back by an open issue labelled
// `release-hold`: one whose title names the tag holds that tag; one that
// names no tag holds everything.
//
// `canary` checks that the public manifest stable clients read now serves
// that version and that every asset it points at can be downloaded.
//
// Zero dependencies (Node 20+).

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export function parseVersionTag(tag) {
  const m = VERSION_TAG.exec(String(tag || ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** Tags held back by open `release-hold` issues; `"*"` means all of them. */
export function holdsFromIssues(issues) {
  const holds = new Set();
  for (const issue of issues || []) {
    const text = `${issue.title ?? ""}\n${issue.body ?? ""}`;
    const tags = text.match(/\bv\d+\.\d+\.\d+\b/g);
    if (tags && tags.length) for (const t of tags) holds.add(t);
    else holds.add("*");
  }
  return holds;
}

/**
 * Decide what to promote.
 *
 * releases: GitHub release objects (tag_name, draft, prerelease, published_at).
 * holds:    from holdsFromIssues.
 * now:      ms since epoch.
 * forceTag: promote this tag now, ignoring the soak (still honours holds).
 */
export function chooseCandidate({ releases, holds = new Set(), now = Date.now(), soakHours = 24, forceTag }) {
  const versioned = (releases || []).filter((r) => parseVersionTag(r.tag_name) && !r.draft);
  const stable = versioned.filter((r) => !r.prerelease).sort((a, b) => compareVersions(parseVersionTag(b.tag_name), parseVersionTag(a.tag_name)));
  const currentLatest = stable[0] ?? null;

  const eligible = (r) => {
    if (!r.prerelease) return { ok: false, why: `${r.tag_name} is already stable` };
    if (holds.has("*") || holds.has(r.tag_name)) return { ok: false, why: `${r.tag_name} is held (open release-hold issue)` };
    if (currentLatest && compareVersions(parseVersionTag(r.tag_name), parseVersionTag(currentLatest.tag_name)) <= 0) {
      return { ok: false, why: `${r.tag_name} is not newer than the current latest ${currentLatest.tag_name}` };
    }
    return { ok: true };
  };

  if (forceTag) {
    const r = versioned.find((x) => x.tag_name === forceTag);
    if (!r) return { tag: null, why: `${forceTag} is not a published, versioned release` };
    const e = eligible(r);
    return e.ok ? { tag: r.tag_name, previous: currentLatest?.tag_name ?? null } : { tag: null, why: e.why };
  }

  const soaked = versioned
    .filter((r) => r.prerelease && r.published_at && now - Date.parse(r.published_at) >= soakHours * 3600 * 1000)
    .sort((a, b) => compareVersions(parseVersionTag(b.tag_name), parseVersionTag(a.tag_name)));
  const reasons = [];
  for (const r of soaked) {
    const e = eligible(r);
    if (e.ok) return { tag: r.tag_name, previous: currentLatest?.tag_name ?? null };
    reasons.push(e.why);
  }
  const waiting = versioned.filter((r) => r.prerelease && !soaked.includes(r)).map((r) => r.tag_name);
  return {
    tag: null,
    why: reasons.length ? reasons.join("; ") : waiting.length ? `${waiting.join(", ")} still soaking` : "no prerelease to promote",
  };
}

/** Problems with a live stable manifest for `tag` (empty = healthy). */
export async function checkLiveManifest({ repo, tag, fetchImpl = fetch, attempts = 10, delayMs = 30_000 }) {
  const url = `https://github.com/${repo}/releases/latest/download/latest.json`;
  const version = tag.replace(/^v/, "");
  let last = "";
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchImpl(url, { redirect: "follow", headers: { "cache-control": "no-cache" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.version !== version) throw new Error(`serves ${json.version}, expected ${version}`);
      const problems = [];
      for (const [key, entry] of Object.entries(json.platforms || {})) {
        if (!entry.signature) problems.push(`${key}: empty signature`);
        const asset = await fetchImpl(entry.url, { method: "GET", redirect: "follow" });
        if (!asset.ok) problems.push(`${key}: ${entry.url} -> HTTP ${asset.status}`);
        try {
          await asset.body?.cancel();
        } catch {
          // The body was already consumed or closed; nothing to release.
        }
      }
      return problems;
    } catch (e) {
      last = e.message;
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return [`${url}: ${last}`];
}

// ─── CLI ─────────────────────────────────────────────────────────────

function gh(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    opts[a.slice(2)] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
  }
  return { command, opts };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { command, opts } = parseArgs(process.argv.slice(2));
  if (!opts.repo) {
    console.error("--repo owner/name is required");
    process.exit(2);
  }
  if (command === "pick") {
    const releases = gh(["api", `repos/${opts.repo}/releases?per_page=50`]);
    const issues = gh(["api", `repos/${opts.repo}/issues?state=open&labels=release-hold&per_page=50`]);
    const result = chooseCandidate({
      releases,
      holds: holdsFromIssues(issues),
      soakHours: Number(opts["soak-hours"] ?? 24),
      forceTag: opts.tag && opts.tag !== "true" ? opts.tag : undefined,
    });
    if (result.tag) console.error(`promote ${result.tag} (previous latest: ${result.previous ?? "none"})`);
    else console.error(`nothing to promote: ${result.why}`);
    console.log(JSON.stringify(result));
  } else if (command === "canary") {
    const problems = await checkLiveManifest({ repo: opts.repo, tag: opts.tag });
    if (problems.length) {
      console.error(`canary: ${problems.length} problem(s)`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(`canary: ${opts.tag} is live for stable clients and every asset downloads`);
  } else {
    console.error(`unknown command ${command}`);
    process.exit(2);
  }
}

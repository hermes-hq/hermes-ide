#!/usr/bin/env node
// Deterministic scrubber for recorded agent sessions (cassettes, .cast files).
//
//   node scrub.mjs <in> [<out>]        (out defaults to in, rewritten in place)
//   node scrub.mjs --check <file>...   exit 1 and list what leaked, if anything
//
// Same input, same output, every time: every home folder (macOS, Linux and
// Windows) becomes the home of a user named "test", the recording user's name
// and host name are replaced, e-mail addresses become user@example.com, UUIDs
// map to a stable
// fake set in order of first appearance, and credential-shaped tokens are
// removed. Scrubbing twice changes nothing.

import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const SCRUBBER_VERSION = 1;

// Credential shapes. Each one found in a fixture is a leak.
export const TOKEN_PATTERNS = [
	{ kind: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{8,}/g },
	{ kind: "openai-key", re: /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
	{ kind: "github-token", re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g },
	// Split so secret scanners do not mistake the pattern itself for a token.
	{ kind: "github-pat", re: new RegExp("github_" + "pat_[A-Za-z0-9_]{20,}", "g") },
	{ kind: "google-api-key", re: /AIza[0-9A-Za-z_-]{30,}/g },
	{ kind: "jwt", re: /eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,}){0,2}/g },
	{ kind: "slack-token", re: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
	{ kind: "aws-access-key", re: /(?:AKIA|ASIA)[0-9A-Z]{16}/g },
	{ kind: "bearer", re: /Bearer\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]{16,}/g },
];

const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const FAKE_UUID_RE = /^00000000-0000-4000-8000-\d{12}$/;
const fakeUuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const SAFE_EMAIL_RE = /@example\.(?:com|org|net)$/i;
// Home folders. The JSON-escaped Windows form (doubled backslashes) is covered too.
const TEST_USER = "test";
const HOME_RES = [
	{ re: /\/Users\/(?!test\b|Shared\b)[^/\s"'\\:]+/g, to: "/Users/" + TEST_USER },
	{ re: /\/home\/(?!test\b)[^/\s"'\\:]+/g, to: "/home/" + TEST_USER },
	{ re: /([A-Za-z]:)(\\\\|\\)Users\2(?!test\b|Public\b)[^\\/\s"':]+/g, to: "$1$2Users$2test" },
];
// Names too generic to replace blindly in free text.
const GENERIC_NAMES = new Set(["root", "admin", "user", "test", "runner", "ubuntu", "vagrant", "localhost"]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The recording machine's identity, or what the caller passes instead. */
export function localIdentity() {
	let user = "";
	try {
		user = os.userInfo().username;
	} catch {
		user = process.env.USER || process.env.USERNAME || "";
	}
	const host = os.hostname();
	return { user, hosts: [...new Set([host, host.split(".")[0]])].filter(Boolean) };
}

function nameRes({ user, hosts = [] }) {
	const out = [];
	for (const h of hosts) {
		if (h.length >= 3 && !GENERIC_NAMES.has(h.toLowerCase())) out.push({ re: new RegExp(`\\b${escapeRe(h)}\\b`, "g"), to: "test-host", kind: "hostname" });
	}
	if (user && user.length >= 3 && !GENERIC_NAMES.has(user.toLowerCase())) {
		out.push({ re: new RegExp(`\\b${escapeRe(user)}\\b`, "g"), to: "test", kind: "username" });
	}
	return out;
}

/**
 * Scrub `text`. `identity` ({ user, hosts }) defaults to this machine's; pass
 * { user: "", hosts: [] } to skip name replacement.
 */
export function scrub(text, identity = localIdentity()) {
	let s = text;
	for (const { kind, re } of TOKEN_PATTERNS) s = s.replace(re, `[REDACTED:${kind}]`);
	for (const { re, to } of HOME_RES) s = s.replace(re, to);
	// Host names before the user name: a host is often "<user>-laptop".
	for (const { re, to } of nameRes(identity)) s = s.replace(re, to);
	s = s.replace(EMAIL_RE, (m) => (SAFE_EMAIL_RE.test(m) ? m : "user@example.com"));

	const used = new Set((s.match(UUID_RE) ?? []).filter((u) => FAKE_UUID_RE.test(u)));
	const map = new Map();
	let n = 0;
	s = s.replace(UUID_RE, (u) => {
		if (FAKE_UUID_RE.test(u)) return u;
		const key = u.toLowerCase();
		if (!map.has(key)) {
			do n++;
			while (used.has(fakeUuid(n)));
			map.set(key, fakeUuid(n));
			used.add(fakeUuid(n));
		}
		return map.get(key);
	});
	return s;
}

/** Everything in `text` that should not be in a committed fixture. */
export function findLeaks(text, identity = { user: "", hosts: [] }) {
	const leaks = [];
	const scan = (kind, re) => {
		for (const m of text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))) {
			leaks.push({ kind, match: m[0], index: m.index });
		}
	};
	for (const { kind, re } of TOKEN_PATTERNS) scan(kind, re);
	for (const { re } of HOME_RES) scan("home-path", re);
	for (const { re, kind } of nameRes(identity)) scan(kind, re);
	for (const m of text.matchAll(EMAIL_RE)) {
		if (!SAFE_EMAIL_RE.test(m[0])) leaks.push({ kind: "email", match: m[0], index: m.index });
	}
	return leaks.sort((a, b) => a.index - b.index);
}

// ─── CLI ─────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
	const args = process.argv.slice(2);
	if (args[0] === "--check") {
		let bad = 0;
		for (const f of args.slice(1)) {
			for (const l of findLeaks(fs.readFileSync(f, "utf8"), localIdentity())) {
				bad++;
				process.stdout.write(`${f}: ${l.kind} at offset ${l.index}\n`);
			}
		}
		process.exit(bad ? 1 : 0);
	}
	if (!args[0]) {
		process.stderr.write("usage: scrub.mjs <in> [<out>] | scrub.mjs --check <file>...\n");
		process.exit(2);
	}
	fs.writeFileSync(args[1] ?? args[0], scrub(fs.readFileSync(args[0], "utf8")));
}

#!/usr/bin/env node
// Keeps cassettes/manifest.json in step with the cassettes on disk.
//
//   node manifest.mjs           list what is out of date (exit 1 if anything)
//   node manifest.mjs --write   rewrite the manifest (keeps each entry's date
//                               unless the file changed)
//
// Layout: cassettes/<agent>/<agent version>/<scenario>.jsonl

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCRUBBER_VERSION } from "./scrub.mjs";

export const CASSETTE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "cassettes");
export const MANIFEST_FILE = path.join(CASSETTE_DIR, "manifest.json");

export function listCassettes(dir = CASSETTE_DIR) {
	const out = [];
	for (const agent of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!agent.isDirectory()) continue;
		for (const version of fs.readdirSync(path.join(dir, agent.name), { withFileTypes: true })) {
			if (!version.isDirectory()) continue;
			for (const f of fs.readdirSync(path.join(dir, agent.name, version.name))) {
				if (f.endsWith(".jsonl") || f.endsWith(".cast")) out.push(`${agent.name}/${version.name}/${f}`);
			}
		}
	}
	return out.sort();
}

export const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export function buildManifest(previous = { cassettes: [] }, today = new Date().toISOString().slice(0, 10)) {
	const prev = new Map(previous.cassettes.map((c) => [c.path, c]));
	return {
		v: 1,
		cassettes: listCassettes().map((p) => {
			const [agent, version, file] = p.split("/");
			const full = path.join(CASSETTE_DIR, p);
			const header = JSON.parse(fs.readFileSync(full, "utf8").split("\n")[0]);
			const hash = sha256(full);
			const old = prev.get(p);
			return {
				path: p,
				agent,
				version,
				scenario: file.replace(/\.(jsonl|cast)$/, ""),
				origin: header.origin ?? "unknown",
				date: old && old.sha256 === hash ? old.date : today,
				sha256: hash,
				scrubber: SCRUBBER_VERSION,
			};
		}),
	};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
	const previous = fs.existsSync(MANIFEST_FILE) ? JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8")) : { cassettes: [] };
	const next = buildManifest(previous);
	const text = JSON.stringify(next, null, "\t") + "\n";
	if (process.argv.includes("--write")) {
		fs.writeFileSync(MANIFEST_FILE, text);
		process.stdout.write(`wrote ${next.cassettes.length} entries to ${MANIFEST_FILE}\n`);
	} else if (fs.existsSync(MANIFEST_FILE) && fs.readFileSync(MANIFEST_FILE, "utf8") === text) {
		process.stdout.write("manifest is up to date\n");
	} else {
		process.stdout.write("manifest is out of date: run node tools/fake-agents/manifest.mjs --write\n");
		process.exit(1);
	}
}

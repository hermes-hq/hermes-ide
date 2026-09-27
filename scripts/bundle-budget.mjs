#!/usr/bin/env node
// Startup bundle budget.
//
// "Startup JS" is every JavaScript file the window has to download and run
// before the app can draw: the entry script(s) in dist/index.html plus
// everything they import statically, transitively. Code behind a dynamic
// import() (lazy views, language packs, editor grammars) is not counted —
// it loads only when used.
//
//   npx vite build && node scripts/bundle-budget.mjs
//   node scripts/bundle-budget.mjs --dist path/to/dist --json
//
// Fails (exit 1) when the startup JS is over the budget in
// bundle-budget.json.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/** Entry scripts and modulepreload links named in index.html. */
export function htmlEntries(html) {
	const out = new Set();
	for (const m of html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/g)) out.add(m[1]);
	for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*\btype=["']module["']/g)) out.add(m[1]);
	for (const m of html.matchAll(/<link\b[^>]*\brel=["']modulepreload["'][^>]*\bhref=["']([^"']+)["']/g)) out.add(m[1]);
	return [...out];
}

/**
 * Relative modules a chunk imports statically: `import … from "./x.js"`,
 * `import "./x.js"` and `export … from "./x.js"`. Dynamic `import("./x.js")`
 * is deliberately not matched.
 */
export function staticImports(code) {
	const out = new Set();
	const patterns = [
		/\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?["'](\.{1,2}\/[^"']+)["']/g,
		/\bexport\s*(?:\*|\{[^}]*\})\s*(?:as\s+[\w$]+\s*)?from\s*["'](\.{1,2}\/[^"']+)["']/g,
	];
	for (const re of patterns) {
		for (const m of code.matchAll(re)) out.add(m[1]);
	}
	return [...out];
}

function toDistPath(distDir, url, fromFile) {
	const clean = url.split(/[?#]/)[0];
	if (/^[a-z]+:/i.test(clean) || clean.startsWith("//")) return null; // external
	if (clean.startsWith("/")) return join(distDir, clean);
	const base = fromFile ? dirname(fromFile) : distDir;
	return join(base, clean);
}

/**
 * Walks the static import graph from index.html and returns
 * { files: [{ file, bytes }], totalBytes }, largest first.
 */
export function measureStartupJs(distDir) {
	const indexHtml = join(distDir, "index.html");
	if (!existsSync(indexHtml)) throw new Error(`no ${indexHtml} — run \`npx vite build\` first`);
	const html = readFileSync(indexHtml, "utf8");
	const queue = htmlEntries(html)
		.map((u) => toDistPath(distDir, u, null))
		.filter((p) => p && p.endsWith(".js"));
	const seen = new Set();
	const files = [];
	while (queue.length > 0) {
		const file = queue.shift();
		if (seen.has(file)) continue;
		seen.add(file);
		if (!existsSync(file)) throw new Error(`startup script referenced but missing: ${file}`);
		const code = readFileSync(file, "utf8");
		files.push({ file: file.slice(distDir.length + 1), bytes: statSync(file).size });
		for (const spec of staticImports(code)) {
			const next = toDistPath(distDir, spec, file);
			if (next && !seen.has(next)) queue.push(next);
		}
	}
	files.sort((a, b) => b.bytes - a.bytes);
	return { files, totalBytes: files.reduce((sum, f) => sum + f.bytes, 0) };
}

export function readBudget(file = join(REPO_ROOT, "bundle-budget.json")) {
	const budget = JSON.parse(readFileSync(file, "utf8"));
	if (!Number.isInteger(budget.startupJsMaxBytes) || budget.startupJsMaxBytes <= 0) {
		throw new Error(`${file}: startupJsMaxBytes must be a positive integer`);
	}
	return budget;
}

/** { ok, totalBytes, maxBytes, files } */
export function checkBudget(distDir, budget) {
	const { files, totalBytes } = measureStartupJs(distDir);
	return { ok: totalBytes <= budget.startupJsMaxBytes, totalBytes, maxBytes: budget.startupJsMaxBytes, files };
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

function main(argv) {
	const distArg = argv.indexOf("--dist");
	const distDir = resolve(distArg >= 0 ? argv[distArg + 1] : join(REPO_ROOT, "dist"));
	const budgetArg = argv.indexOf("--budget");
	const budget = readBudget(budgetArg >= 0 ? resolve(argv[budgetArg + 1]) : undefined);
	const result = checkBudget(distDir, budget);
	if (argv.includes("--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log("Startup JS (loaded before the app can draw):");
		for (const f of result.files) console.log(`  ${kb(f.bytes).padStart(10)}  ${f.file}`);
		console.log(`  ${"-".repeat(10)}`);
		console.log(`  ${kb(result.totalBytes).padStart(10)}  total (${result.totalBytes} bytes)`);
		console.log(`  ${kb(result.maxBytes).padStart(10)}  budget (${result.maxBytes} bytes)`);
		console.log(
			result.ok
				? `BUNDLE BUDGET: OK — ${kb(result.maxBytes - result.totalBytes)} to spare`
				: `BUNDLE BUDGET: OVER by ${kb(result.totalBytes - result.maxBytes)} — load the new code on demand (React.lazy / import()) or raise the budget in bundle-budget.json with a reason`,
		);
	}
	return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (e) {
		console.error(`BUNDLE BUDGET: ERROR — ${e.message}`);
		process.exit(2);
	}
}

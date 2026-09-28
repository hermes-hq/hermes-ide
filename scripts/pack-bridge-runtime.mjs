#!/usr/bin/env node
// Pack the Claude bridge runtime into ONE compressed file for the installer
// (ADR 002).
//
// The bridge (`src-tauri/bridge/*.mjs`) needs its npm dependencies next to
// it: the Claude Agent SDK, zod, their transitive deps and the SDK's native
// `claude` binary for this platform — about 270 MB in some 6 000 files.
// Shipped raw, that tree broke the AppImage (linuxdeploy cannot bundle it)
// and made every installer about 100 MB heavier.
//
// This script writes
//   src-tauri/bridge/runtime/bridge-runtime.tar.zst   the bridge files + node_modules
//   src-tauri/bridge/runtime/manifest.json            what the app needs to unpack it
// and the app unpacks the archive into its data folder the first time an
// Agent-view session needs the bridge (src-tauri/src/agent/runtime.rs).
//
//   node scripts/pack-bridge-runtime.mjs            # pack (skips when nothing changed)
//   node scripts/pack-bridge-runtime.mjs --force    # pack even when up to date
//   node scripts/pack-bridge-runtime.mjs --level 3  # faster, larger (tests)
//   HERMES_PACK_LEVEL=3 npx tauri build ...          # same, for a test build
//   node scripts/pack-bridge-runtime.mjs --bridge-dir <dir> --out-dir <dir>
//
// The archive is deterministic: same inputs, same bytes (sorted entries,
// fixed timestamps and owners), so the runtime id only changes when the
// runtime does. zstd runs on several threads (its output does not depend on
// how many). Zero dependencies; needs Node 22.15+ for zstd.

import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BRIDGE_DIR = resolve(HERE, "..", "src-tauri", "bridge");
export const DEFAULT_OUT_DIR = join(DEFAULT_BRIDGE_DIR, "runtime");
export const ARCHIVE_NAME = "bridge-runtime.tar.zst";
export const MANIFEST_NAME = "manifest.json";
/** Bumped when the archive layout or the manifest changes meaning. */
export const FORMAT = 1;
/** Every entry gets this timestamp (2020-01-01T00:00:00Z) so packs are reproducible. */
const FIXED_MTIME = 1577836800;
const BLOCK = 512;

// ─── What goes in ────────────────────────────────────────────────────

/**
 * The files of the runtime, relative to `bridgeDir`, with forward slashes,
 * sorted. The bridge's own top-level files (every `.mjs` and package.json)
 * plus the whole node_modules tree, minus npm's `.bin` link folders and
 * its hidden lock file (neither is read at runtime).
 *
 * Throws on a symlink anywhere else: the archive must not depend on links
 * that do not exist on the user's machine.
 */
export function collectFiles(bridgeDir) {
	const out = [];
	for (const name of readdirSync(bridgeDir).sort()) {
		const full = join(bridgeDir, name);
		const st = lstatSync(full);
		if (st.isFile() && (name.endsWith(".mjs") || name === "package.json")) {
			out.push({ rel: name, full, size: st.size, mode: st.mode, mtimeMs: st.mtimeMs });
		}
	}
	const nm = join(bridgeDir, "node_modules");
	if (!existsSync(nm)) throw new Error(`no node_modules in ${bridgeDir} — run \`npm run prepare:bridge\` first`);
	const walk = (dir, rel) => {
		for (const name of readdirSync(dir).sort()) {
			if (name === ".bin") continue;
			if (rel === "node_modules" && name === ".package-lock.json") continue;
			const full = join(dir, name);
			const childRel = `${rel}/${name}`;
			const st = lstatSync(full);
			if (st.isSymbolicLink()) throw new Error(`symlink in the bridge runtime is not supported: ${childRel}`);
			if (st.isDirectory()) walk(full, childRel);
			else if (st.isFile()) out.push({ rel: childRel, full, size: st.size, mode: st.mode, mtimeMs: st.mtimeMs });
		}
	};
	walk(nm, "node_modules");
	out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	return out;
}

/** Hash of every input's path, size, mode and mtime: "did anything change?". */
export function inputFingerprint(files, level) {
	const h = createHash("sha256");
	h.update(`format ${FORMAT} level ${level}\n`);
	for (const f of files) h.update(`${f.rel}\0${f.size}\0${f.mode}\0${Math.floor(f.mtimeMs)}\n`);
	return h.digest("hex");
}

// ─── tar (ustar + pax long names) ────────────────────────────────────

function octal(value, width) {
	// width includes the trailing NUL
	const s = value.toString(8);
	if (s.length > width - 1) throw new Error(`value ${value} does not fit in a ${width}-byte tar field`);
	return s.padStart(width - 1, "0") + "\0";
}

function header({ name, size, mode, type }) {
	const buf = Buffer.alloc(BLOCK, 0);
	const nameBytes = Buffer.from(name, "utf8");
	if (nameBytes.length > 100) throw new Error(`tar name too long for a plain header: ${name}`);
	nameBytes.copy(buf, 0);
	buf.write(octal(mode, 8), 100, "ascii");
	buf.write(octal(0, 8), 108, "ascii"); // uid
	buf.write(octal(0, 8), 116, "ascii"); // gid
	buf.write(octal(size, 12), 124, "ascii");
	buf.write(octal(FIXED_MTIME, 12), 136, "ascii");
	buf.write("        ", 148, "ascii"); // checksum placeholder
	buf.write(type, 156, "ascii");
	buf.write("ustar\0", 257, "ascii");
	buf.write("00", 263, "ascii");
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += buf[i];
	buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
	return buf;
}

function padding(size) {
	const rest = size % BLOCK;
	return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rest, 0);
}

/** One pax record: "<len> <key>=<value>\n", where <len> counts itself. */
export function paxRecord(key, value) {
	const body = ` ${key}=${value}\n`;
	let len = Buffer.byteLength(body, "utf8");
	let total = len + String(len).length;
	while (String(total).length + len !== total) total = len + String(total).length;
	return `${total}${body}`;
}

/** The header block(s) for one regular file: a pax header first when the name needs one. */
export function fileHeaders(rel, size, executable) {
	const mode = executable ? 0o755 : 0o644;
	const bytes = Buffer.byteLength(rel, "utf8");
	if (bytes <= 100 && /^[\x20-\x7e]+$/.test(rel)) return [header({ name: rel, size, mode, type: "0" })];
	const pax = Buffer.from(paxRecord("path", rel), "utf8");
	const short = `PaxHeaders/${rel.split("/").pop()}`.slice(0, 100);
	return [
		header({ name: short, size: pax.length, mode: 0o644, type: "x" }),
		pax,
		padding(pax.length),
		header({ name: short.replace(/[^\x20-\x7e]/g, "_"), size, mode, type: "0" }),
	];
}

function isExecutable(mode) {
	return (mode & 0o111) !== 0;
}

/**
 * The whole tar archive for `files`, in memory (about 270 MB for the real
 * runtime): zstd compresses a buffer on several threads, a stream on one.
 */
export function tarBuffer(files) {
	const parts = [];
	for (const f of files) {
		parts.push(...fileHeaders(f.rel, f.size, isExecutable(f.mode)));
		const data = readFileSync(f.full);
		if (data.length !== f.size) throw new Error(`${f.rel} changed while being packed`);
		parts.push(data, padding(f.size));
	}
	parts.push(Buffer.alloc(BLOCK * 2, 0));
	return Buffer.concat(parts);
}

// ─── pack ────────────────────────────────────────────────────────────

function sdkVersion(bridgeDir) {
	const p = join(bridgeDir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
	if (!existsSync(p)) throw new Error(`the Claude Agent SDK is not staged in ${bridgeDir}/node_modules`);
	return JSON.parse(readFileSync(p, "utf8")).version;
}

/** The SDK's platform packages found in node_modules (the native `claude` binary lives there). */
export function nativePackages(files) {
	const out = new Set();
	for (const f of files) {
		const m = /^node_modules\/@anthropic-ai\/(claude-agent-sdk-[^/]+)\//.exec(f.rel);
		if (m) out.add(m[1]);
	}
	return [...out].sort();
}

/**
 * Pack `bridgeDir` into `outDir`. Returns the manifest (plus `skipped: true`
 * when the existing pack already matches the inputs).
 */
export async function packRuntime({ bridgeDir = DEFAULT_BRIDGE_DIR, outDir = DEFAULT_OUT_DIR, level = 19, force = false, log = () => {} } = {}) {
	if (typeof zlib.zstdCompressSync !== "function") {
		throw new Error(`this Node (${process.version}) has no zstd support — use Node 22.15 or newer`);
	}
	const files = collectFiles(bridgeDir);
	if (!files.some((f) => f.rel === "hermes-claude-bridge.mjs")) throw new Error(`no hermes-claude-bridge.mjs in ${bridgeDir}`);
	const fingerprint = inputFingerprint(files, level);
	const manifestPath = join(outDir, MANIFEST_NAME);
	const archivePath = join(outDir, ARCHIVE_NAME);

	if (!force && existsSync(manifestPath) && existsSync(archivePath)) {
		try {
			const old = JSON.parse(readFileSync(manifestPath, "utf8"));
			if (old.inputFingerprint === fingerprint && old.archiveBytes === statSync(archivePath).size) {
				log(`[pack-bridge-runtime] up to date (${old.id}) — skipping`);
				return { ...old, skipped: true };
			}
		} catch {
			// unreadable manifest: pack again
		}
	}

	mkdirSync(outDir, { recursive: true });
	const started = Date.now();
	const tar = tarBuffer(files);
	const archive = zlib.zstdCompressSync(tar, {
		params: {
			[zlib.constants.ZSTD_c_compressionLevel]: level,
			[zlib.constants.ZSTD_c_checksumFlag]: 1,
			// Level 19 takes about a minute on one thread, a quarter of that
			// on eight. The output does not depend on the thread count.
			[zlib.constants.ZSTD_c_nbWorkers]: Math.max(1, Math.min(availableParallelism(), 8)),
		},
	});
	const tmpArchive = `${archivePath}.tmp-${process.pid}`;
	try {
		writeFileSync(tmpArchive, archive);
		renameSync(tmpArchive, archivePath);
	} catch (e) {
		rmSync(tmpArchive, { force: true });
		throw e;
	}

	const tarSha = createHash("sha256").update(tar).digest("hex");
	const manifest = {
		format: FORMAT,
		// Names the folder the app unpacks into; changes whenever any file does.
		id: tarSha.slice(0, 16),
		sdkVersion: sdkVersion(bridgeDir),
		native: nativePackages(files),
		archive: ARCHIVE_NAME,
		archiveSha256: createHash("sha256").update(archive).digest("hex"),
		archiveBytes: archive.length,
		tarSha256: tarSha,
		unpackedBytes: files.reduce((n, f) => n + f.size, 0),
		fileCount: files.length,
		entry: "hermes-claude-bridge.mjs",
		inputFingerprint: fingerprint,
	};
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
	log(
		`[pack-bridge-runtime] ${files.length} files, ${(manifest.unpackedBytes / 1e6).toFixed(1)} MB → ` +
			`${(manifest.archiveBytes / 1e6).toFixed(1)} MB (zstd ${level}, ${((Date.now() - started) / 1000).toFixed(1)} s), id ${manifest.id}`,
	);
	return manifest;
}

// ─── CLI ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const opts = { force: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--force") opts.force = true;
		else if (a === "--level") opts.level = Number(argv[++i]);
		else if (a === "--bridge-dir") opts.bridgeDir = resolve(argv[++i]);
		else if (a === "--out-dir") opts.outDir = resolve(argv[++i]);
		else throw new Error(`unknown argument ${a}`);
	}
	if (opts.level !== undefined && !(Number.isInteger(opts.level) && opts.level >= 1 && opts.level <= 22)) {
		throw new Error("--level must be 1..22");
	}
	return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const opts = parseArgs(process.argv.slice(2));
		if (opts.level === undefined && process.env.HERMES_PACK_LEVEL) opts.level = parseArgs(["--level", process.env.HERMES_PACK_LEVEL]).level;
		await packRuntime({ ...opts, log: console.log });
	} catch (e) {
		console.error(`[pack-bridge-runtime] ${e.message}`);
		process.exit(1);
	}
}

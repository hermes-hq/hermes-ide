#!/usr/bin/env node
// Fetch the prompt library catalog that ships inside Hermes (offline by
// default), pinned by prompt-library.lock.json.
//
// The catalog (hermes-hq/hodios-dist, catalog/v1) is a manifest plus
// content-addressed objects: shard lists, NDJSON shards of rows, the vocab
// and one body object per entry. This script
//
//   1. downloads the manifest at the locked tag (jsDelivr first, then raw
//      GitHub) and refuses it unless its sha256 is the lock's;
//   2. walks the hash chain (tier lists -> shards -> every row's body, the
//      vocab, the packs) and refuses any object whose sha256 is not its name;
//   3. writes src-tauri/library/catalog-v1.tar.zst (the manifest and every
//      object, deterministic: sorted, fixed timestamps) and
//      src-tauri/library/catalog-v1.json (what the app and the tests check).
//
// It fails loudly: a missing object, a hash mismatch, an archive over the
// lock's size cap or a lock/manifest disagreement exits 1 and writes nothing.
// Objects are cached under ~/.cache/hermes-library/<manifest sha> (or
// HERMES_LIBRARY_CACHE), checked again on every use.
//
//   node scripts/fetch-prompt-library.mjs              # skips when up to date
//   node scripts/fetch-prompt-library.mjs --force
//   node scripts/fetch-prompt-library.mjs --offline    # cache only, no network
//   node scripts/fetch-prompt-library.mjs --bump v2026.1004.0   # re-pin the lock to a tag
//
// Zero dependencies; Node 22.15+ (zstd).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");
export const LOCK_PATH = join(REPO_ROOT, "prompt-library.lock.json");
export const OUT_DIR = join(REPO_ROOT, "src-tauri", "library");
export const ARCHIVE_NAME = "catalog-v1.tar.zst";
export const SIDECAR_NAME = "catalog-v1.json";
/** Every tar entry gets this timestamp (2020-01-01T00:00:00Z) so archives are reproducible. */
const FIXED_MTIME = 1577836800;
const BLOCK = 512;
const CONCURRENCY = 24;

// ─── Hashes and paths ────────────────────────────────────────────────

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** "sha256:<64 hex>" -> "<64 hex>", or throws. */
export function hashHex(ref, what = "object") {
	const m = /^sha256:([0-9a-f]{64})$/.exec(String(ref ?? ""));
	if (!m) throw new Error(`${what}: not a sha256 reference: ${JSON.stringify(ref)}`);
	return m[1];
}

/** Path of an object under catalog/v1 (manifest.objects is "o/{aa}/{sha256}"). */
export const objectRel = (hex) => `o/${hex.slice(0, 2)}/${hex}`;

export function mirrorUrls(lock) {
	return lock.mirrors.map((m) => m.replace("{tag}", lock.tag));
}

// ─── Walking the hash chain ──────────────────────────────────────────

/**
 * Every object the bundled catalog needs, verified. `getObject(rel, hex)`
 * returns the bytes of one object (any source); each is checked here.
 * Returns { files: Map<rel, Buffer>, manifest, rows, bodies }.
 */
export async function collectCatalog({ manifestBytes, lock, getObject, concurrency = CONCURRENCY }) {
	const manifestSha = sha256Hex(manifestBytes);
	if (manifestSha !== lock.manifest_sha256) {
		throw new Error(`manifest sha256 is ${manifestSha}, the lock pins ${lock.manifest_sha256}: refusing it`);
	}
	const manifest = JSON.parse(manifestBytes.toString("utf8"));
	if (manifest.schema !== 1) throw new Error(`manifest schema ${manifest.schema} is not supported (1)`);
	if (manifest.catalog !== lock.catalog || manifest.seq !== lock.seq) {
		throw new Error(`manifest is ${manifest.catalog} seq ${manifest.seq}, the lock says ${lock.catalog} seq ${lock.seq}`);
	}
	if (manifest.objects && manifest.objects !== "o/{aa}/{sha256}") {
		throw new Error(`unknown object layout ${manifest.objects}`);
	}
	const files = new Map([["manifest.json", manifestBytes]]);
	const fetchVerified = async (ref, what) => {
		const hex = hashHex(ref, what);
		const rel = objectRel(hex);
		if (files.has(rel)) return files.get(rel);
		const bytes = await getObject(rel, hex);
		if (!bytes) throw new Error(`${what}: object ${hex} is missing`);
		const got = sha256Hex(bytes);
		if (got !== hex) throw new Error(`${what}: object ${hex} has sha256 ${got}: refusing it`);
		files.set(rel, bytes);
		return bytes;
	};

	if (manifest.vocab) await fetchVerified(manifest.vocab, "vocab");
	for (const [name, ref] of Object.entries(manifest.packs ?? {})) {
		await fetchVerified(typeof ref === "string" ? ref : ref?.object, `pack ${name}`);
	}
	const rows = [];
	const tiers = {};
	for (const [tier, info] of Object.entries(manifest.tiers ?? {})) {
		const list = JSON.parse((await fetchVerified(info.list, `${tier} shard list`)).toString("utf8"));
		if (list.schema !== 1) throw new Error(`${tier} shard list schema ${list.schema} is not supported`);
		let tierRows = 0;
		for (const [prefix, shard] of Object.entries(list.shards ?? {})) {
			const text = (await fetchVerified(shard.object, `${tier} shard "${prefix}"`)).toString("utf8");
			const shardRows = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
			if (typeof shard.rows === "number" && shard.rows !== shardRows.length) {
				throw new Error(`${tier} shard "${prefix}" has ${shardRows.length} rows, its list says ${shard.rows}`);
			}
			// A row's stored tier is its own field: it must be the list's.
			const stray = shardRows.find((r) => r.tier !== tier);
			if (stray) throw new Error(`${tier} shard "${prefix}": ${stray.id} says tier ${JSON.stringify(stray.tier)}`);
			tierRows += shardRows.length;
			rows.push(...shardRows);
		}
		if (typeof info.rows === "number" && info.rows !== tierRows) {
			throw new Error(`${tier} tier has ${tierRows} rows, the manifest says ${info.rows}`);
		}
		tiers[tier] = tierRows;
	}
	if (typeof lock.rows === "number" && rows.length !== lock.rows) {
		throw new Error(`the catalog has ${rows.length} rows, the lock says ${lock.rows}`);
	}
	// Bodies, in parallel (about 1,600 small objects).
	const bodies = [...new Set(rows.map((r) => r.body).filter(Boolean))];
	let next = 0;
	const worker = async () => {
		while (next < bodies.length) {
			const ref = bodies[next++];
			await fetchVerified(ref, `body ${ref}`);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
	return { files, manifest, rows, tiers, bodies: bodies.length };
}

// ─── Archive (ustar, deterministic) ──────────────────────────────────

function octal(value, width) {
	const s = value.toString(8);
	if (s.length > width - 1) throw new Error(`value ${value} does not fit in a ${width}-byte tar field`);
	return s.padStart(width - 1, "0") + "\0";
}

function header(name, size) {
	const buf = Buffer.alloc(BLOCK, 0);
	const nameBytes = Buffer.from(name, "utf8");
	if (nameBytes.length > 100 || !/^[\x20-\x7e]+$/.test(name)) throw new Error(`tar name not supported: ${name}`);
	nameBytes.copy(buf, 0);
	buf.write(octal(0o644, 8), 100, "ascii");
	buf.write(octal(0, 8), 108, "ascii");
	buf.write(octal(0, 8), 116, "ascii");
	buf.write(octal(size, 12), 124, "ascii");
	buf.write(octal(FIXED_MTIME, 12), 136, "ascii");
	buf.write("        ", 148, "ascii");
	buf.write("0", 156, "ascii");
	buf.write("ustar\0", 257, "ascii");
	buf.write("00", 263, "ascii");
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += buf[i];
	buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
	return buf;
}

/** A tar of `files` (Map rel -> bytes), entries sorted by name. */
export function tarBuffer(files) {
	const parts = [];
	for (const name of [...files.keys()].sort()) {
		const data = files.get(name);
		parts.push(header(name, data.length), data);
		const rest = data.length % BLOCK;
		if (rest) parts.push(Buffer.alloc(BLOCK - rest, 0));
	}
	parts.push(Buffer.alloc(BLOCK * 2, 0));
	return Buffer.concat(parts);
}

export function zstd(buf) {
	if (typeof zlib.zstdCompressSync !== "function") throw new Error("Node 22.15+ is needed (zstd)");
	return zlib.zstdCompressSync(buf, {
		params: {
			[zlib.constants.ZSTD_c_compressionLevel]: 19,
			[zlib.constants.ZSTD_c_checksumFlag]: 1,
		},
	});
}

/** Writes the archive and its sidecar atomically; returns the sidecar. */
export function writeArchive({ files, lock, rows, tiers = {}, outDir = OUT_DIR }) {
	const archive = zstd(tarBuffer(files));
	if (archive.length > lock.max_archive_bytes) {
		throw new Error(`the archive is ${archive.length} bytes, over the ${lock.max_archive_bytes}-byte cap in the lock`);
	}
	const sidecar = {
		format: 1,
		source: lock.source,
		tag: lock.tag,
		catalog: lock.catalog,
		seq: lock.seq,
		rows,
		tiers,
		objects: files.size - 1,
		manifest_sha256: lock.manifest_sha256,
		archive: ARCHIVE_NAME,
		archive_bytes: archive.length,
		archive_sha256: sha256Hex(archive),
	};
	mkdirSync(outDir, { recursive: true });
	const tmp = join(outDir, `${ARCHIVE_NAME}.tmp`);
	writeFileSync(tmp, archive);
	renameSync(tmp, join(outDir, ARCHIVE_NAME));
	writeFileSync(join(outDir, SIDECAR_NAME), `${JSON.stringify(sidecar, null, 2)}\n`);
	return sidecar;
}

/** Whether outDir already holds the archive for this lock, intact. */
export function upToDate(lock, outDir = OUT_DIR) {
	const sidecarPath = join(outDir, SIDECAR_NAME);
	const archivePath = join(outDir, ARCHIVE_NAME);
	if (!existsSync(sidecarPath) || !existsSync(archivePath)) return false;
	try {
		const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
		// A sidecar without per-tier counts predates them: write it again.
		return (
			sidecar.manifest_sha256 === lock.manifest_sha256 &&
			typeof sidecar.tiers === "object" &&
			sidecar.archive_sha256 === sha256Hex(readFileSync(archivePath))
		);
	} catch {
		return false;
	}
}

// ─── Network ─────────────────────────────────────────────────────────

async function fetchBytes(url, attempts = 3) {
	let last;
	for (let i = 0; i < attempts; i++) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
			if (res.ok) return Buffer.from(await res.arrayBuffer());
			last = new Error(`${url}: HTTP ${res.status}`);
			if (res.status === 404) break;
		} catch (e) {
			last = e;
		}
		await new Promise((r) => setTimeout(r, 300 * (i + 1)));
	}
	throw last;
}

/** The first mirror that serves `rel` (a 404 or an error moves to the next). */
async function fromMirrors(mirrors, rel) {
	const errors = [];
	for (const base of mirrors) {
		try {
			return await fetchBytes(`${base}/${rel}`);
		} catch (e) {
			errors.push(e.message);
		}
	}
	throw new Error(`no mirror served ${rel}: ${errors.join("; ")}`);
}

function cacheDir(lock) {
	const root = process.env.HERMES_LIBRARY_CACHE || join(homedir(), ".cache", "hermes-library");
	return join(root, lock.manifest_sha256);
}

// ─── Commands ────────────────────────────────────────────────────────

export function readLock(path = LOCK_PATH) {
	const lock = JSON.parse(readFileSync(path, "utf8"));
	for (const k of ["tag", "catalog", "seq", "manifest_sha256", "mirrors", "max_archive_bytes"]) {
		if (lock[k] === undefined) throw new Error(`prompt-library.lock.json: missing "${k}"`);
	}
	return lock;
}

async function fetchCatalog({ force = false, offline = false } = {}) {
	const lock = readLock();
	if (!force && upToDate(lock)) {
		console.log(`[library] ${lock.catalog} is already in src-tauri/library (up to date)`);
		return;
	}
	const mirrors = mirrorUrls(lock);
	const cache = cacheDir(lock);
	const cached = (rel) => {
		const p = join(cache, rel);
		return existsSync(p) ? readFileSync(p) : null;
	};
	const remember = (rel, bytes) => {
		const p = join(cache, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, bytes);
	};
	const get = async (rel, hex) => {
		const hit = cached(rel);
		if (hit && (!hex || sha256Hex(hit) === hex)) return hit;
		if (offline) throw new Error(`offline and ${rel} is not cached in ${cache}`);
		const bytes = await fromMirrors(mirrors, rel);
		if (!hex || sha256Hex(bytes) === hex) remember(rel, bytes);
		return bytes;
	};
	let manifestBytes = cached("manifest.json");
	if (!manifestBytes || sha256Hex(manifestBytes) !== lock.manifest_sha256) {
		if (offline) throw new Error(`offline and the manifest is not cached in ${cache}`);
		manifestBytes = await fromMirrors(mirrors, "manifest.json");
		if (sha256Hex(manifestBytes) === lock.manifest_sha256) remember("manifest.json", manifestBytes);
	}
	const started = Date.now();
	const { files, rows, tiers, bodies } = await collectCatalog({ manifestBytes, lock, getObject: get });
	const sidecar = writeArchive({ files, lock, rows: rows.length, tiers });
	const byTier = Object.entries(tiers).map(([t, n]) => `${t} ${n}`).join(", ");
	console.log(
		`[library] ${lock.catalog} (seq ${lock.seq}): ${rows.length} rows (${byTier}), ${bodies} bodies, ${files.size - 1} objects verified; ` +
			`${ARCHIVE_NAME} ${(sidecar.archive_bytes / 1e6).toFixed(2)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s`,
	);
}

async function bump(tag) {
	if (!/^v\d{4}\.\d{4}\.\d+$/.test(tag ?? "")) throw new Error(`usage: --bump v<calver>, e.g. v2026.1004.0 (got ${tag})`);
	const lock = readLock();
	const next = { ...lock, tag };
	const manifestBytes = await fromMirrors(mirrorUrls(next), "manifest.json");
	const manifest = JSON.parse(manifestBytes.toString("utf8"));
	next.catalog = manifest.catalog;
	next.seq = manifest.seq;
	next.rows = Object.values(manifest.tiers ?? {}).reduce((n, t) => n + (t.rows ?? 0), 0);
	next.manifest_sha256 = sha256Hex(manifestBytes);
	writeFileSync(LOCK_PATH, `${JSON.stringify(next, null, 2)}\n`);
	console.log(`[library] lock now pins ${tag}: catalog ${next.catalog} seq ${next.seq}, ${next.rows} rows`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const args = process.argv.slice(2);
	const run = args.includes("--bump")
		? bump(args[args.indexOf("--bump") + 1])
		: fetchCatalog({ force: args.includes("--force"), offline: args.includes("--offline") });
	run.catch((e) => {
		console.error(`[library] FAILED: ${e.message}`);
		rmSync(join(OUT_DIR, `${ARCHIVE_NAME}.tmp`), { force: true });
		process.exit(1);
	});
}

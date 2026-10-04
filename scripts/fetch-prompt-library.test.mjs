import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { collectCatalog, objectRel, readLock, sha256Hex, tarBuffer, upToDate, writeArchive } from "./fetch-prompt-library.mjs";

/**
 * A two-row catalog in memory, built the way hodios-dist lays it out: one
 * row in each tier, each tier with its own shard list. `betaTier` is the
 * tier field beta's row carries.
 */
function fakeCatalog({ betaTier = "verified" } = {}) {
	const objects = new Map();
	const put = (text) => {
		const bytes = Buffer.from(text, "utf8");
		const hex = sha256Hex(bytes);
		objects.set(objectRel(hex), bytes);
		return `sha256:${hex}`;
	};
	const body = (id) => put(JSON.stringify({ schema: 1, fm: { id, kind: "prompt", title: id }, body: `Do ${id}.`, steps: [] }));
	const list = (tier, id, rowTier = tier) => {
		const shard = put(`${JSON.stringify({ id, v: "1.0.0", kind: "prompt", tier: rowTier, body: body(id) })}\n`);
		return { list: put(JSON.stringify({ schema: 1, tier, prefixLen: 0, shards: { "": { object: shard, rows: 1 } } })), rows: 1 };
	};
	const tiers = { curated: list("curated", "alpha"), verified: list("verified", "beta", betaTier) };
	const vocab = put(JSON.stringify({ schema: 1, facets: {}, domains: {}, detect: {} }));
	const manifest = Buffer.from(JSON.stringify({ schema: 1, catalog: "2026.0101.0", seq: 1, objects: "o/{aa}/{sha256}", tiers, deltas: [], packs: {}, vocab }));
	const lock = {
		source: "test",
		tag: "v2026.0101.0",
		catalog: "2026.0101.0",
		seq: 1,
		rows: 2,
		manifest_sha256: sha256Hex(manifest),
		mirrors: [],
		max_archive_bytes: 1_000_000,
	};
	const getObject = async (rel) => objects.get(rel);
	return { objects, manifest, lock, getObject };
}

const dirs = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("fetch-prompt-library", () => {
	it("pins the real lock to a tag and a manifest hash", () => {
		const lock = readLock();
		expect(lock.tag).toMatch(/^v\d{4}\.\d{4}\.\d+$/);
		expect(lock.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(lock.mirrors.every((m) => m.includes("{tag}") && !m.includes("@latest"))).toBe(true);
		expect(lock.max_archive_bytes).toBeLessThanOrEqual(6_000_000);
	});

	it("collects every object of the hash chain, every tier", async () => {
		const c = fakeCatalog();
		const out = await collectCatalog({ manifestBytes: c.manifest, lock: c.lock, getObject: c.getObject });
		expect(out.rows.map((r) => r.id)).toEqual(["alpha", "beta"]);
		expect(out.tiers).toEqual({ curated: 1, verified: 1 });
		// manifest + 2 lists + 2 shards + vocab + 2 bodies
		expect(out.files.size).toBe(8);
	});

	it("refuses a row whose tier is not its shard list's", async () => {
		for (const betaTier of ["curated", null]) {
			const c = fakeCatalog({ betaTier });
			await expect(collectCatalog({ manifestBytes: c.manifest, lock: c.lock, getObject: c.getObject })).rejects.toThrow(/beta says tier/);
		}
	});

	it("refuses a manifest the lock does not pin", async () => {
		const c = fakeCatalog();
		const other = Buffer.from(c.manifest.toString().replace("2026.0101.0", "2026.0101.9"));
		await expect(collectCatalog({ manifestBytes: other, lock: c.lock, getObject: c.getObject })).rejects.toThrow(/lock pins/);
	});

	it("refuses an object whose bytes do not match its hash", async () => {
		const c = fakeCatalog();
		const getObject = async (rel) => {
			const bytes = c.objects.get(rel);
			const text = bytes.toString();
			return text.includes("Do beta.") ? Buffer.from(text.replace("Do beta.", "Do evil.")) : bytes;
		};
		await expect(collectCatalog({ manifestBytes: c.manifest, lock: c.lock, getObject })).rejects.toThrow(/refusing it/);
	});

	it("refuses a missing object and a row count the lock does not expect", async () => {
		const c = fakeCatalog();
		const missing = async (rel) => (c.objects.get(rel)?.toString().includes("Do alpha.") ? undefined : c.objects.get(rel));
		await expect(collectCatalog({ manifestBytes: c.manifest, lock: c.lock, getObject: missing })).rejects.toThrow(/missing/);
		await expect(collectCatalog({ manifestBytes: c.manifest, lock: { ...c.lock, rows: 3 }, getObject: c.getObject })).rejects.toThrow(/rows/);
	});

	it("writes a reproducible archive and a sidecar the build can check", async () => {
		const c = fakeCatalog();
		const { files } = await collectCatalog({ manifestBytes: c.manifest, lock: c.lock, getObject: c.getObject });
		expect(sha256Hex(tarBuffer(files))).toBe(sha256Hex(tarBuffer(new Map([...files].reverse()))));
		const outDir = mkdtempSync(join(tmpdir(), "hermes-lib-test-"));
		dirs.push(outDir);
		const sidecar = writeArchive({ files, lock: c.lock, rows: 2, tiers: { curated: 1, verified: 1 }, outDir });
		expect(sidecar.tiers).toEqual({ curated: 1, verified: 1 });
		const archive = readFileSync(join(outDir, sidecar.archive));
		expect(sha256Hex(archive)).toBe(sidecar.archive_sha256);
		expect(zlib.zstdDecompressSync(archive).includes(Buffer.from("manifest.json"))).toBe(true);
		expect(upToDate(c.lock, outDir)).toBe(true);
		expect(upToDate({ ...c.lock, manifest_sha256: "0".repeat(64) }, outDir)).toBe(false);
	});

	it("refuses an archive over the size cap", async () => {
		const c = fakeCatalog();
		const { files } = await collectCatalog({ manifestBytes: c.manifest, lock: c.lock, getObject: c.getObject });
		const outDir = mkdtempSync(join(tmpdir(), "hermes-lib-test-"));
		dirs.push(outDir);
		expect(() => writeArchive({ files, lock: { ...c.lock, max_archive_bytes: 10 }, rows: 2, outDir })).toThrow(/cap/);
	});
});

// The bridge runtime packer (ADR 002). Every test packs a synthetic bridge
// folder in a temp directory with the real packer, then reads the archive
// back: with a small tar reader here and with the system's own `tar`.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { ARCHIVE_NAME, MANIFEST_NAME, packRuntime, paxRecord } from "./pack-bridge-runtime.mjs";

let root;
let bridge;
let out;

function put(rel, content, mode) {
	const p = join(bridge, rel);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, content);
	if (mode) chmodSync(p, mode);
}

const LONG = `node_modules/@scope/${"deep-package-name/".repeat(8)}index.js`;

function syntheticBridge() {
	put("hermes-claude-bridge.mjs", 'import "./helper.mjs";\n');
	put("helper.mjs", "export {};\n");
	put("package.json", '{"type":"module"}\n');
	put("package-lock.json", "{}\n");
	put("notes.txt", "not part of the runtime\n");
	put("node_modules/@anthropic-ai/claude-agent-sdk/package.json", '{"version":"1.2.3"}\n');
	put("node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs", "export function query() {}\n");
	put("node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude", "#!/bin/sh\necho claude\n", 0o755);
	put("node_modules/.package-lock.json", "{}\n");
	put("node_modules/.bin/placeholder", "x\n");
	put(LONG, "export const deep = true;\n");
}

/** Minimal tar reader: [{ name, size, mode, type, data }] with pax paths applied. */
function readTar(buf) {
	const entries = [];
	let off = 0;
	let paxPath = null;
	while (off + 512 <= buf.length) {
		const h = buf.subarray(off, off + 512);
		if (h.every((b) => b === 0)) break;
		const str = (a, b) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
		const size = parseInt(str(124, 136).trim() || "0", 8);
		const type = String.fromCharCode(h[156]);
		const stored = h.readUInt32BE(0) === 0 ? 0 : parseInt(str(148, 156).trim(), 8);
		const copy = Buffer.from(h);
		copy.fill(0x20, 148, 156);
		const sum = copy.reduce((a, b) => a + b, 0);
		expect(stored, `checksum of ${str(0, 100)}`).toBe(sum);
		const data = buf.subarray(off + 512, off + 512 + size);
		off += 512 + Math.ceil(size / 512) * 512;
		if (type === "x") {
			const m = /\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
			paxPath = m ? m[1] : null;
			continue;
		}
		entries.push({ name: paxPath ?? str(0, 100), size, mode: parseInt(str(100, 108), 8), type, data: Buffer.from(data) });
		paxPath = null;
	}
	return entries;
}

function unpackTar() {
	return readTar(zlib.zstdDecompressSync(readFileSync(join(out, ARCHIVE_NAME))));
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hermes-pack-"));
	bridge = join(root, "bridge");
	out = join(root, "out");
	syntheticBridge();
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("pack-bridge-runtime", () => {
	it("packs the bridge scripts and node_modules, and nothing npm does not read at runtime", async () => {
		const m = await packRuntime({ bridgeDir: bridge, outDir: out, level: 3 });
		const names = unpackTar().map((e) => e.name);
		expect(names).toEqual([
			"helper.mjs",
			"hermes-claude-bridge.mjs",
			"node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
			"node_modules/@anthropic-ai/claude-agent-sdk/package.json",
			"node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
			LONG,
			"package.json",
		]);
		expect(m.fileCount).toBe(names.length);
		expect(m.sdkVersion).toBe("1.2.3");
		expect(m.native).toEqual(["claude-agent-sdk-linux-x64"]);
		expect(m.entry).toBe("hermes-claude-bridge.mjs");
	});

	it("writes a manifest whose size and checksum match the archive, and an id from the content", async () => {
		const m = await packRuntime({ bridgeDir: bridge, outDir: out, level: 3 });
		const onDisk = JSON.parse(readFileSync(join(out, MANIFEST_NAME), "utf8"));
		expect(onDisk).toEqual(m);
		const archive = readFileSync(join(out, ARCHIVE_NAME));
		expect(m.archiveBytes).toBe(archive.length);
		expect(m.archiveSha256).toBe(createHash("sha256").update(archive).digest("hex"));
		const tar = zlib.zstdDecompressSync(archive);
		expect(m.tarSha256).toBe(createHash("sha256").update(tar).digest("hex"));
		expect(m.id).toBe(m.tarSha256.slice(0, 16));
		expect(m.id).toMatch(/^[0-9a-f]{16}$/);
	});

	it("keeps file contents and the executable bit", async () => {
		await packRuntime({ bridgeDir: bridge, outDir: out, level: 3 });
		const byName = Object.fromEntries(unpackTar().map((e) => [e.name, e]));
		expect(byName["node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"].mode).toBe(0o755);
		expect(byName["hermes-claude-bridge.mjs"].mode).toBe(0o644);
		expect(byName[LONG].data.toString()).toBe("export const deep = true;\n");
	});

	it.skipIf(process.platform === "win32")("produces an archive the system tar unpacks, long names included", async () => {
		await packRuntime({ bridgeDir: bridge, outDir: out, level: 3 });
		const tarFile = join(root, "plain.tar");
		writeFileSync(tarFile, zlib.zstdDecompressSync(readFileSync(join(out, ARCHIVE_NAME))));
		const dest = join(root, "dest");
		mkdirSync(dest);
		const r = spawnSync("tar", ["-xf", tarFile, "-C", dest], { encoding: "utf8" });
		expect(r.status, r.stderr).toBe(0);
		expect(readFileSync(join(dest, LONG), "utf8")).toBe("export const deep = true;\n");
		expect(statSync(join(dest, "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude")).mode & 0o111).toBe(0o111);
		expect(existsSync(join(dest, "node_modules/.bin"))).toBe(false);
	});

	it("is reproducible: the same inputs give the same bytes, whatever the file times", async () => {
		const a = await packRuntime({ bridgeDir: bridge, outDir: out, level: 3 });
		const first = readFileSync(join(out, ARCHIVE_NAME));
		utimesSync(join(bridge, "helper.mjs"), new Date(2001, 1, 1), new Date(2001, 1, 1));
		const b = await packRuntime({ bridgeDir: bridge, outDir: out, level: 3 });
		expect(b.skipped).toBeUndefined();
		expect(readFileSync(join(out, ARCHIVE_NAME)).equals(first)).toBe(true);
		expect(b.id).toBe(a.id);
	});

	it("skips when nothing changed and packs again when a file did", async () => {
		const a = await packRuntime({ bridgeDir: bridge, outDir: out, level: 3 });
		const again = await packRuntime({ bridgeDir: bridge, outDir: out, level: 3 });
		expect(again.skipped).toBe(true);
		expect(again.id).toBe(a.id);
		put("helper.mjs", "export const changed = 1;\n");
		const changed = await packRuntime({ bridgeDir: bridge, outDir: out, level: 3 });
		expect(changed.skipped).toBeUndefined();
		expect(changed.id).not.toBe(a.id);
		const forced = await packRuntime({ bridgeDir: bridge, outDir: out, level: 3, force: true });
		expect(forced.skipped).toBeUndefined();
		expect(forced.id).toBe(changed.id);
	});

	it("packs again when the archive on disk no longer matches its manifest", async () => {
		await packRuntime({ bridgeDir: bridge, outDir: out, level: 3 });
		writeFileSync(join(out, ARCHIVE_NAME), "truncated");
		const again = await packRuntime({ bridgeDir: bridge, outDir: out, level: 3 });
		expect(again.skipped).toBeUndefined();
		expect(statSync(join(out, ARCHIVE_NAME)).size).toBe(again.archiveBytes);
	});

	it("refuses a bridge folder without node_modules, the SDK or the bridge script", async () => {
		rmSync(join(bridge, "node_modules"), { recursive: true });
		await expect(packRuntime({ bridgeDir: bridge, outDir: out, level: 3 })).rejects.toThrow(/prepare:bridge/);
		syntheticBridge();
		rmSync(join(bridge, "node_modules/@anthropic-ai/claude-agent-sdk"), { recursive: true });
		await expect(packRuntime({ bridgeDir: bridge, outDir: out, level: 3 })).rejects.toThrow(/Claude Agent SDK/);
		syntheticBridge();
		rmSync(join(bridge, "hermes-claude-bridge.mjs"));
		await expect(packRuntime({ bridgeDir: bridge, outDir: out, level: 3 })).rejects.toThrow(/hermes-claude-bridge/);
	});

	it.skipIf(process.platform === "win32")("refuses a symlink inside node_modules", async () => {
		symlinkSync("/etc/hosts", join(bridge, "node_modules", "linked"));
		await expect(packRuntime({ bridgeDir: bridge, outDir: out, level: 3 })).rejects.toThrow(/symlink/);
		expect(existsSync(join(out, ARCHIVE_NAME))).toBe(false);
	});

	it("pax records count their own length", () => {
		for (const value of ["a", "x".repeat(90), "y".repeat(994), "z".repeat(9995)]) {
			const rec = paxRecord("path", value);
			const len = Number(rec.split(" ")[0]);
			expect(Buffer.byteLength(rec)).toBe(len);
			expect(rec.endsWith(`path=${value}\n`)).toBe(true);
		}
	});

	it("every relative import of the real bridge scripts is inside the archive", async () => {
		// The real bridge scripts next to a synthetic node_modules: an import
		// the packer drops would crash every installed Agent session (the
		// v1.1.4 → v1.1.5 regression).
		const real = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "src-tauri", "bridge");
		const realBridge = join(root, "real-bridge");
		mkdirSync(realBridge);
		const scripts = ["hermes-claude-bridge.mjs", "canUseToolHelpers.mjs", "bridgeRuntimeHelpers.mjs", "package.json"];
		for (const f of scripts) writeFileSync(join(realBridge, f), readFileSync(join(real, f)));
		mkdirSync(join(realBridge, "node_modules/@anthropic-ai/claude-agent-sdk"), { recursive: true });
		writeFileSync(join(realBridge, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), '{"version":"0.0.0"}');
		await packRuntime({ bridgeDir: realBridge, outDir: out, level: 1 });
		const entries = unpackTar();
		const names = new Set(entries.map((e) => e.name));
		const imports = new Set();
		for (const e of entries.filter((x) => x.name.endsWith(".mjs") && !x.name.includes("/"))) {
			for (const m of e.data.toString("utf8").matchAll(/from\s+["']\.\/([^"']+)["']/g)) imports.add(m[1]);
		}
		expect(imports.size).toBeGreaterThan(0);
		for (const rel of imports) expect(names.has(rel), `the bridge imports ./${rel}`).toBe(true);
	});
});

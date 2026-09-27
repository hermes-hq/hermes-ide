// Test helper: run one of the kit's scripts as a real child process and talk
// to it over pipes, the way Hermes (or a shell) does.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const kit = (...p) => path.join(KIT, ...p);

export function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "fake-agents-test-"));
}

/**
 * Start `node <script> ...args`. Returns a handle with:
 *   write(text), writeJson(obj), end()
 *   nextJson(pred, ms)   the next stdout JSON line matching pred
 *   done                 Promise<{ code, signal, stdout: Buffer, stderr: string }>
 */
export function start(script, args = [], { env = {}, cwd = KIT } = {}) {
	const child = spawn(process.execPath, [script, ...args], {
		cwd,
		env: { ...process.env, ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const out = [];
	let err = "";
	let lineBuf = "";
	const lines = [];
	let notify = null;
	child.stdout.on("data", (b) => {
		out.push(b);
		lineBuf += b.toString("utf8");
		let nl;
		while ((nl = lineBuf.indexOf("\n")) >= 0) {
			lines.push(lineBuf.slice(0, nl));
			lineBuf = lineBuf.slice(nl + 1);
		}
		notify?.();
	});
	child.stderr.on("data", (b) => {
		err += b.toString("utf8");
	});
	child.stdin.on("error", () => {}); // the child may exit before reading everything
	const done = new Promise((resolve) => {
		child.on("close", (code, signal) => {
			notify?.();
			resolve({ code, signal, stdout: Buffer.concat(out), stderr: err });
		});
	});
	let exited = false;
	done.then(() => (exited = true));
	let seen = 0;

	return {
		child,
		done,
		write: (t) => child.stdin.write(t),
		writeJson: (o) => child.stdin.write(JSON.stringify(o) + "\n"),
		end: () => child.stdin.end(),
		kill: (sig) => child.kill(sig),
		isRunning: () => !exited,
		/** Resolve with the next JSON stdout line that satisfies `pred`. */
		nextJson(pred = () => true, ms = 5000) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					notify = null;
					reject(new Error(`no matching stdout line within ${ms} ms; got:\n${lines.join("\n")}\nstderr:\n${err}`));
				}, ms);
				const check = () => {
					while (seen < lines.length) {
						const l = lines[seen++];
						let obj;
						try {
							obj = JSON.parse(l);
						} catch {
							continue;
						}
						if (pred(obj)) {
							clearTimeout(timer);
							notify = null;
							resolve(obj);
							return;
						}
					}
					if (exited) {
						clearTimeout(timer);
						notify = null;
						reject(new Error(`process ended before a matching line; got:\n${lines.join("\n")}\nstderr:\n${err}`));
					}
				};
				notify = check;
				check();
			});
		},
	};
}

/** Every JSON line of a stdout buffer (non-JSON lines skipped). */
export function jsonLines(buf) {
	return buf
		.toString("utf8")
		.split("\n")
		.flatMap((l) => {
			try {
				return [JSON.parse(l)];
			} catch {
				return [];
			}
		});
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

#!/usr/bin/env node
// Captures a database fixture from a REAL old Hermes release (macOS only).
//
//   node src-tauri/tests/fixtures/db/capture.mjs v1.4.0 [v1.3.2 ...]
//
// For each tag it:
//   1. downloads the release's macOS app (gh release download),
//   2. runs it for a while with a throwaway home folder, a throwaway temp
//      folder, a changed bundle identifier and no network access, so it can
//      neither see nor touch an installed Hermes or reach the internet,
//   3. writes the synthetic rows from seed.sql into the database it created,
//   4. runs the old app once more on that data (its own startup code runs),
//   5. checkpoints the WAL, clears anything the app captured from the shell,
//      and saves a SQL dump as <tag>.sql next to this file.
//
// The dump is refused if it contains the current user name, host name or
// the throwaway folder paths.
//
// Work folder: $HERMES_FIXTURE_WORK or <tmpdir>/hermes-db-fixtures.

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, platform, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = "hermes-hq/hermes-ide";
const ASSET = "darwin-aarch64-HERMES-IDE.app.tar.gz";
const DB_NAME = "hermes_idea_v3.db";
const DATA_ID = "com.hermes-ide.terminal";
// Only the macOS/WebKit side reads the bundle id; changing it keeps the old
// app's window state and web storage away from an installed Hermes.
const CAPTURE_BUNDLE_ID = "com.hermes-ide.terminal.fixture-capture";
const NO_NETWORK = "(version 1)(allow default)(deny network-outbound (remote ip))";
const FIXTURE_HOME = "/fixture-home";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(cmd, args, opts = {}) {
	const res = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
	if (res.status !== 0) {
		throw new Error(`${cmd} ${args.join(" ")} failed (${res.status}): ${res.stderr || res.stdout}`);
	}
	return res.stdout;
}

function sqlite(db, sql) {
	return sh("sqlite3", [db], { input: sql });
}

function tableCount(db) {
	if (!existsSync(db)) return 0;
	try {
		return Number(sqlite(db, "SELECT COUNT(*) FROM sqlite_master WHERE type='table';").trim());
	} catch {
		return 0;
	}
}

async function runOldApp(app, root, log, { minMs, maxMs }) {
	const home = join(root, "home");
	const tmp = join(root, "tmp");
	mkdirSync(home, { recursive: true });
	mkdirSync(tmp, { recursive: true });
	const db = join(home, "Library", "Application Support", DATA_ID, DB_NAME);
	const child = spawn("sandbox-exec", ["-p", NO_NETWORK, join(app, "Contents", "MacOS", "hermes-ide")], {
		env: {
			PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
			HOME: home,
			CFFIXED_USER_HOME: home,
			TMPDIR: `${tmp}/`,
			USER: "test",
			LOGNAME: "test",
			SHELL: "/bin/zsh",
			LANG: "en_US.UTF-8",
		},
		stdio: ["ignore", "ignore", "ignore"],
	});
	let exited = false;
	child.on("exit", () => {
		exited = true;
	});
	const started = Date.now();
	while (!exited && Date.now() - started < maxMs) {
		if (Date.now() - started >= minMs && tableCount(db) > 0) break;
		await sleep(500);
	}
	if (exited) throw new Error(`the old app exited on its own after ${Date.now() - started} ms`);
	log(`  ran ${Math.round((Date.now() - started) / 1000)} s, pid ${child.pid}`);
	child.kill("SIGTERM");
	for (let i = 0; i < 20 && !exited; i++) await sleep(250);
	if (!exited) child.kill("SIGKILL");
	for (let i = 0; i < 20 && !exited; i++) await sleep(250);
	if (!existsSync(db)) throw new Error(`the old app never created ${db}`);
	return { db, home };
}

async function capture(tag, work) {
	const log = (m) => console.log(`[${tag}] ${m}`);
	const dir = join(work, tag);
	const root = join(dir, "run");
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });

	const bundleOrig = join(dir, "HERMES-IDE.app");
	if (!existsSync(bundleOrig)) {
		log("downloading the release app");
		sh("gh", ["release", "download", tag, "-R", REPO, "--pattern", ASSET, "--dir", dir, "--clobber"]);
		sh("tar", ["xzf", join(dir, ASSET), "-C", dir]);
	}
	const app = join(root, "HERMES-IDE.app");
	cpSync(bundleOrig, app, { recursive: true });
	sh("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIdentifier ${CAPTURE_BUNDLE_ID}`, join(app, "Contents", "Info.plist")]);
	sh("codesign", ["--force", "--deep", "--sign", "-", app]);

	log("first launch (creates the database)");
	const { db, home } = await runOldApp(app, root, log, { minMs: 15_000, maxMs: 60_000 });
	log(`  tables: ${tableCount(db)}`);

	log("writing synthetic rows");
	sqlite(db, readFileSync(join(HERE, "seed.sql"), "utf8"));

	log("second launch (the old app opens the seeded data)");
	await runOldApp(app, root, log, { minMs: 12_000, maxMs: 60_000 });

	const snap = join(dir, "snapshot.db");
	for (const suffix of ["", "-wal", "-shm"]) {
		rmSync(snap + suffix, { force: true });
		if (existsSync(db + suffix)) cpSync(db + suffix, snap + suffix);
	}
	// Keep only what seed.sql wrote in columns that can hold shell output.
	sqlite(
		snap,
		`PRAGMA wal_checkpoint(TRUNCATE);
		 UPDATE sessions SET scrollback_snapshot = NULL WHERE id NOT LIKE 'fx-%';
		 DELETE FROM execution_log WHERE session_id NOT LIKE 'fx-%';
		 DELETE FROM execution_nodes WHERE session_id NOT LIKE 'fx-%';
		 DELETE FROM context_snapshots WHERE session_id NOT LIKE 'fx-%';
		 PRAGMA journal_mode=DELETE;`,
	);

	let dump = sqlite(snap, ".dump");
	// Paths of the throwaway home become /fixture-home.
	for (const p of [join("/private", home), home]) dump = dump.split(p).join(FIXTURE_HOME);

	const leaks = [userInfo().username, hostname(), work, tmpdir(), "/var/folders"].filter(
		(s) => s && s.length > 2 && dump.includes(s),
	);
	if (leaks.length) throw new Error(`refusing to save: the dump contains ${leaks.join(", ")}`);

	const header = `-- Database written by the real Hermes ${tag} release (macOS arm64 build),
-- with the synthetic rows from seed.sql. Captured by capture.mjs.
`;
	const target = join(HERE, `${tag}.sql`);
	writeFileSync(target, header + dump);
	log(`saved ${target}`);
}

if (platform() !== "darwin") {
	console.error("capture.mjs runs the macOS release build; run it on a Mac.");
	process.exit(2);
}
const tags = process.argv.slice(2);
if (!tags.length) {
	console.error("usage: capture.mjs <tag> [<tag> ...]");
	process.exit(2);
}
const work = process.env.HERMES_FIXTURE_WORK || join(tmpdir(), "hermes-db-fixtures");
for (const tag of tags) await capture(tag, work);

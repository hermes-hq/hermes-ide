#!/usr/bin/env node
// QA-host-data-in-db-file (CHAOS-14) — after a clean quit everything Hermes
// saved used to sit in the database's write-ahead log (`-wal`) only; the
// `.db` file alone (a copy, a backup, a sync) looked empty. EXPECT: after a
// clean quit the log is folded into the `.db` (the `-wal` is empty or gone)
// and the `.db` file alone holds the tables and the saved workspace.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { newTerminal, startApp } from "../qa-host-steps.mjs";

const SCENARIO = "QA-host-data-in-db-file";
await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const { app, bridge } = await startApp("qa-wal", evidenceDir, log, onCleanup, apps);
  await newTerminal(bridge, "keep-me");
  await sleep(2500);
  const exit = await app.stop({ keepFiles: true });
  onCleanup(() => app.cleanup());
  log(`  quit: ${JSON.stringify(exit)}`);
  const db = join(app.dataDir, "hermes_idea_v3.db");
  const wal = `${db}-wal`;
  const walSize = existsSync(wal) ? statSync(wal).size : 0;
  const bytes = readFileSync(db);
  log(`  .db ${bytes.length} bytes; -wal ${walSize} bytes`);
  assert(walSize === 0, "the write-ahead log is folded into the database file");
  assert(bytes.includes(Buffer.from("CREATE TABLE")), "the .db alone holds Hermes's tables");
  assert(bytes.includes(Buffer.from("saved_workspace")) && bytes.includes(Buffer.from("keep-me")), "and the workspace saved at quit");
});

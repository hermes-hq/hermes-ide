#!/usr/bin/env node
// THROWAWAY negative control (reverted before merge): always fails, to show
// that a red scenario fails its shard and the gate.
import { join } from "node:path";
import { createLogger, finishScenario, outDir } from "../harness.mjs";

const SCENARIO = "CIFAST-negative-control";
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const log = createLogger(join(evidenceDir, "scenario.log"));
log("FAILED: deliberate failure (negative control)");
finishScenario({ scenario: SCENARIO, evidenceDir, failed: true, startedAt: Date.now(), log });

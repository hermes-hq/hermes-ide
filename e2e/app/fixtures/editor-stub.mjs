#!/usr/bin/env node
// Stands in for $EDITOR in the Feature Track scenario: records the file it
// was asked to open (into HERMES_E2E_EDITOR_MARKER) and exits.
import fs from "node:fs";
const marker = process.env.HERMES_E2E_EDITOR_MARKER;
if (marker) fs.writeFileSync(marker, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
process.stdout.write(`editor-stub: opened ${process.argv.slice(2).join(" ")}\n`);

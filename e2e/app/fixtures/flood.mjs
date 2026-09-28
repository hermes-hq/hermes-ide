#!/usr/bin/env node
// Prints <megabytes> MB of plain text lines as fast as the terminal takes
// them, then one line "<marker> <bytes> bytes in <ms> ms". Used by the F24
// scenario to measure terminal throughput: the scenario times how long the
// app takes until the marker is on screen.
//
//   node flood.mjs <megabytes> <marker> [pause-ms]
//
// With pause-ms, it waits that long after every 64 KB (the F24 negative
// control: output that arrives slower than the budget).

const mb = Number(process.argv[2] || "8");
const marker = process.argv[3] || "flood-done";
const pauseMs = Number(process.argv[4] || "0");
if (!Number.isFinite(mb) || mb <= 0 || mb > 512) {
  process.stderr.write("usage: flood.mjs <megabytes 1..512> <marker>\n");
  process.exit(2);
}

// 100-byte lines of varied printable text (the renderer cannot cache one line).
const lines = [];
for (let i = 0; i < 64; i++) {
  let s = `${String(i).padStart(3, "0")} `;
  while (s.length < 99) s += String.fromCharCode(33 + ((s.length * 7 + i * 13) % 94));
  lines.push(s + "\n");
}
const chunk = lines.join("").repeat(160); // ~1 MB per write
const total = Math.round(mb * 1024 * 1024);
const started = Date.now();
let written = 0;

async function paced() {
  const piece = chunk.slice(0, 64 * 1024);
  while (written < total) {
    const part = piece.slice(0, Math.min(piece.length, total - written));
    written += part.length;
    if (!process.stdout.write(part)) await new Promise((r) => process.stdout.once("drain", r));
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  process.stdout.write(`\n${marker} ${written} bytes in ${Date.now() - started} ms\n`);
}

function pump() {
  while (written < total) {
    const piece = written + chunk.length <= total ? chunk : chunk.slice(0, total - written);
    written += piece.length;
    if (!process.stdout.write(piece)) {
      process.stdout.once("drain", pump);
      return;
    }
  }
  process.stdout.write(`\n${marker} ${written} bytes in ${Date.now() - started} ms\n`);
}
if (pauseMs > 0) paced();
else pump();

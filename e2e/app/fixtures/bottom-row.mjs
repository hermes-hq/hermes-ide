#!/usr/bin/env node
// Bottom-row fixture for real-app scenarios: a full-screen program that
// draws on the last row of the size its terminal reports, the way an agent's
// TUI draws its status lines at the bottom, and draws again on every resize.
//
//   node e2e/app/fixtures/bottom-row.mjs          # normal screen
//   node e2e/app/fixtures/bottom-row.mjs --alt    # alternate screen
//
// First row: "TOP-ROW"; last row: "BOTTOM-ROW <rows>x<cols>", the size the
// terminal reports (the PTY's), short enough not to wrap in a narrow pane.
// It reads the keyboard raw and exits on "q" (or after 10 minutes).

const alt = process.argv.includes("--alt");
if (!process.stdout.isTTY || !process.stdin.isTTY) {
  console.error("bottom-row: not a terminal");
  process.exit(2);
}

function draw() {
  const rows = process.stdout.rows;
  const cols = process.stdout.columns;
  const bottom = `BOTTOM-ROW ${rows}x${cols}`;
  // Clear, then the first row and the last row (cursor addresses are 1-based).
  process.stdout.write(`\x1b[2J\x1b[1;1HTOP-ROW\x1b[${rows};1H${bottom}`);
}

if (alt) process.stdout.write("\x1b[?1049h");
process.stdout.write("\x1b[?25l");
draw();
process.stdout.on("resize", draw);

function quit() {
  process.stdout.write(`\x1b[?25h${alt ? "\x1b[?1049l" : "\x1b[2J\x1b[1;1H"}`);
  process.exit(0);
}
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  if (chunk.includes(0x71)) quit();
});
setTimeout(quit, 10 * 60_000).unref();

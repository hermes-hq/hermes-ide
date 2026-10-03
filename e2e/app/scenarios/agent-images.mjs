#!/usr/bin/env node
// agent-images — README claim "Real images — paste images straight into the
// composer; Claude sees the actual pixels" (Agent view for Claude).
//
// The fake bridge (e2e/app/fixtures/fake-claude-bridge.mjs, started through
// HERMES_BRIDGE_PATH like the real one) logs every content block of each
// message it receives; for an image, its media type, size and the sha256 of
// the decoded bytes. EXPECT:
//   - pasting a PNG into the Agent view composer (a real paste event whose
//     clipboard holds the file) shows it as an attachment before sending;
//   - sending delivers one message to Claude holding an image block
//     (base64, image/png) whose bytes hash to exactly the pasted file, plus
//     the typed text; the attachment row clears and Claude answers.
// A composer that dropped the image, re-encoded it or sent only its name
// fails the byte-for-byte check.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/agent-images.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { REPO_ROOT, launchApp } from "../harness.mjs";
import { completeOnboarding, runScenario } from "../n11-steps.mjs";
import { sendAgentMessage, startAgentViewSession } from "../agent-setup-steps.mjs";

const SCENARIO = "agent-images";
const PROMPT = "what is in this picture?";

/** A tiny PNG (8x8, four coloured quadrants) built here, so its bytes are known. */
function quadrantPng() {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const size = 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const colours = [[230, 40, 40], [40, 200, 70], [40, 90, 230], [240, 210, 30]];
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [0];
    for (let x = 0; x < size; x++) row.push(...colours[(y < size / 2 ? 0 : 2) + (x < size / 2 ? 0 : 1)]);
    rows.push(Buffer.from(row));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const work = mkdtempSync(join(tmpdir(), "hermes-e2e-images-"));
  onCleanup(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const bridgeCopy = join(work, "fake-claude-bridge.mjs");
  copyFileSync(join(REPO_ROOT, "e2e", "app", "fixtures", "fake-claude-bridge.mjs"), bridgeCopy);
  const fakeLog = join(work, "fake-bridge.ndjson");
  const fakeEvents = () =>
    existsSync(fakeLog) ? readFileSync(fakeLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

  const png = quadrantPng();
  const pngSha = createHash("sha256").update(png).digest("hex");
  log(`  test image: ${png.length} bytes PNG, sha256 ${pngSha}`);

  const app = await launchApp({ runDir: join(evidenceDir, "run"), log, env: { HERMES_BRIDGE_PATH: bridgeCopy, HERMES_FAKE_BRIDGE_LOG: fakeLog } });
  apps.push(app);
  const { bridge } = app;
  const folder = join(realpathSync(app.tmpDir), "picture-repo");
  mkdirSync(folder, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", folder]);
  execFileSync("git", ["-C", folder, "-c", "user.name=Hermes Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);

  await completeOnboarding(bridge, log);
  const sid = await startAgentViewSession(bridge, log, { folder });
  const VIEW = `document.querySelector('.agent-session-view[data-session-id="' + CSS.escape(${JSON.stringify(sid)}) + '"]')`;

  log("step 1: paste the PNG into the composer");
  if (!(await bridge.exists(".session-composer-input"))) await bridge.click(".session-composer-fab");
  await bridge.waitFor("the composer", `return !!e2e.first(".session-composer-input");`);
  const pasted = await bridge.eval(`
    const ta = e2e.must(e2e.first(".session-composer-input"), "the composer");
    ta.focus();
    const bin = atob(${JSON.stringify(png.toString("base64"))});
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "screenshot.png", { type: "image/png" }));
    let ev;
    let via = "ClipboardEvent";
    try { ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }); } catch { ev = null; }
    if (!ev || !ev.clipboardData) {
      // Engines whose ClipboardEvent constructor ignores clipboardData: the
      // same event, with the clipboard attached the way the browser does.
      via = "paste Event with clipboardData";
      ev = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "clipboardData", { value: dt });
    }
    ta.dispatchEvent(ev);
    return { via, items: dt.items.length, type: dt.items[0]?.type };`);
  log(`  paste event: ${JSON.stringify(pasted)}`);
  const pill = await bridge.waitFor("the attachment to show", `
    const pills = e2e.all(".session-composer-attachment");
    return pills.length === 1 ? { title: pills[0].title, hasImage: !!pills[0].querySelector("img") } : null;`, { timeoutMs: 10_000 });
  log(`  attachment: ${JSON.stringify(pill)}`);
  assert(/\.png$/.test(pill.title), "the pasted PNG shows as an attachment in the composer");
  await bridge.screenshot(join(evidenceDir, "01-attached.png"));

  log("step 2: send it with a question");
  await sendAgentMessage(bridge, log, PROMPT);
  await bridge.waitFor("Claude's answer", `return (${VIEW}?.innerText || "").includes(${JSON.stringify(`fake reply: ${PROMPT}`)});`, { timeoutMs: 30_000 });
  const cleared = await bridge.waitFor("the attachment row to clear", `return e2e.all(".session-composer-attachment").length === 0;`, { timeoutMs: 10_000 }).catch(() => false);
  assert(cleared, "the attachment row clears once the message is sent");
  await bridge.screenshot(join(evidenceDir, "02-sent.png"));

  log("step 3: what Claude received");
  const users = fakeEvents().filter((e) => e.event === "input" && e.type === "user");
  log(`  user messages received: ${JSON.stringify(users.map((u) => u.blocks))}`);
  assert(users.length === 1, "exactly one message reached Claude");
  const blocks = users[0].blocks ?? [];
  const images = blocks.filter((b) => b.type === "image");
  assert(images.length === 1, "the message carries one image block");
  assert(images[0].source_type === "base64" && images[0].media_type === "image/png", "the image is sent as base64 image/png");
  assert(images[0].bytes === png.length && images[0].sha256 === pngSha, "the image bytes Claude received are exactly the pasted file's");
  assert(blocks.some((b) => b.type === "text" && b.text === PROMPT), "the typed question travels with it");
});

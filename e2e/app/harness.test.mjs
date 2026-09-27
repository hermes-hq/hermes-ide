// Behavioural tests for the harness's bridge client against a stand-in
// bridge server: the token travels with every request, refusals surface as
// errors, script failures inside the app become errors, and waits poll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Bridge, e2eDataDir, inheritedEnv, pngFlatColour, prepareAppHome, E2E_IDENTIFIER } from "./harness.mjs";

const TOKEN = "t".repeat(64);
let server;
let port;
const seen = [];
let evalResponses = [];
/** What the stand-in app writes when asked for a screenshot: a pixel function, or null to fail. */
let screenshotPixels = null;

// ─── A tiny PNG writer, so the tests can hand the harness real files ──

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** 8-bit PNG; `pixel(x, y)` returns [r, g, b] or [r, g, b, a]; `filter` picks the row filter. */
export function encodePng(width, height, pixel, { filter = 0 } = {}) {
  const channels = pixel(0, 0).length;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  const previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) Buffer.from(pixel(x, y)).copy(row, x * channels);
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = previous[i];
      const predicted = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : 0;
      raw[y * (stride + 1) + 1 + i] = (row[i] - predicted) & 0xff;
    }
    row.copy(previous);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = { 1: 0, 3: 2, 4: 6 }[channels];
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const reply = (status, json) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { ok: false, error: "missing or wrong token" });
      if (req.url === "/health") return reply(200, { ok: true, identifier: E2E_IDENTIFIER, pid: 1, version: "0.0.0" });
      if (req.url === "/eval") return reply(200, evalResponses.shift() ?? { ok: true, value: null });
      if (req.url === "/screenshot") {
        if (!screenshotPixels) return reply(500, { ok: false, error: "no window" });
        const { file } = JSON.parse(body);
        writeFileSync(file, encodePng(40, 30, screenshotPixels));
        return reply(200, { ok: true, file, width: 40, height: 30 });
      }
      return reply(404, { ok: false, error: "unknown route" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});

afterAll(() => server.close());

describe("Bridge", () => {
  it("sends the bearer token with every request", async () => {
    const bridge = new Bridge({ port, token: TOKEN, pid: 1 });
    const health = await bridge.health();
    expect(health.identifier).toBe(E2E_IDENTIFIER);
    expect(seen.at(-1)).toMatchObject({ method: "GET", url: "/health", auth: `Bearer ${TOKEN}` });
  });

  it("turns a refusal into an error that names the status", async () => {
    const bridge = new Bridge({ port, token: "wrong", pid: 1 });
    await expect(bridge.health()).rejects.toThrow(/401.*missing or wrong token/);
  });

  it("prepends the DOM helpers and unwraps the script's value", async () => {
    const bridge = new Bridge({ port, token: TOKEN, pid: 1 });
    evalResponses = [{ ok: true, value: { answer: 42 } }];
    expect(await bridge.eval("return { answer: 42 };")).toEqual({ answer: 42 });
    const sent = JSON.parse(seen.at(-1).body);
    expect(sent.script).toMatch(/const e2e = /);
    expect(sent.script).toMatch(/return \{ answer: 42 \};$/);
    expect(sent.timeoutMs).toBe(10_000);
  });

  it("raises when the script failed inside the app", async () => {
    const bridge = new Bridge({ port, token: TOKEN, pid: 1 });
    evalResponses = [{ ok: false, value: "boom\n  at <anonymous>" }];
    await expect(bridge.eval("throw new Error('boom')")).rejects.toThrow(/script failed in the app: boom/);
  });

  it("waitFor polls until the script returns something truthy", async () => {
    const bridge = new Bridge({ port, token: TOKEN, pid: 1 });
    evalResponses = [
      { ok: true, value: null },
      { ok: true, value: false },
      { ok: true, value: "ready" },
    ];
    expect(await bridge.waitFor("readiness", "return x;", { intervalMs: 1 })).toBe("ready");
  });

  it("waitFor reports the last value when it gives up", async () => {
    const bridge = new Bridge({ port, token: TOKEN, pid: 1 });
    evalResponses = [];
    await expect(bridge.waitFor("something", "return null;", { timeoutMs: 30, intervalMs: 5 })).rejects.toThrow(
      /timed out after 30 ms waiting for: something/,
    );
  });

  it("screenshot surfaces the app's error instead of a missing file", async () => {
    const bridge = new Bridge({ port, token: TOKEN, pid: 1 });
    const dir = mkdtempSync(join(tmpdir(), "hermes-harness-"));
    try {
      screenshotPixels = null;
      await expect(bridge.screenshot(join(dir, "shot.png"))).rejects.toThrow(/500.*no window/);
      expect(existsSync(join(dir, "shot.png"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("screenshot lets the page paint first, then keeps a real picture", async () => {
    const bridge = new Bridge({ port, token: TOKEN, pid: 1 });
    const dir = mkdtempSync(join(tmpdir(), "hermes-harness-"));
    try {
      screenshotPixels = (x, y) => [x * 6, y * 8, 40];
      const before = seen.length;
      const shot = await bridge.screenshot(join(dir, "shot.png"));
      expect(shot).toMatchObject({ bytes: expect.any(Number), width: 40, height: 30 });
      expect(existsSync(shot.file)).toBe(true);
      const calls = seen.slice(before).map((r) => r.url);
      expect(calls).toEqual(["/eval", "/screenshot"]);
      expect(JSON.parse(seen.slice(before)[0].body).script).toMatch(/requestAnimationFrame/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("screenshot refuses a capture that is one flat colour", async () => {
    const bridge = new Bridge({ port, token: TOKEN, pid: 1 });
    const dir = mkdtempSync(join(tmpdir(), "hermes-harness-"));
    try {
      screenshotPixels = () => [0, 0, 0];
      await expect(bridge.screenshot(join(dir, "black.png"))).rejects.toThrow(/one flat colour \(#000000\)/);
      expect(existsSync(join(dir, "black.png"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pngFlatColour", () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-png-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const png = (name, ...args) => {
    const file = join(dir, name);
    writeFileSync(file, encodePng(...args));
    return file;
  };

  it("names the colour of a flat RGB, RGBA and greyscale picture", () => {
    expect(pngFlatColour(png("rgb.png", 8, 8, () => [0, 0, 0]))).toBe("#000000");
    expect(pngFlatColour(png("rgba.png", 8, 8, () => [255, 255, 255, 255]))).toBe("#ffffff");
    expect(pngFlatColour(png("grey.png", 8, 8, () => [17]))).toBe("#111111");
  });

  it("returns null as soon as one pixel differs, whatever the row filter", () => {
    for (const filter of [0, 1, 2, 3]) {
      const file = png(`filter-${filter}.png`, 16, 9, (x, y) => (x === 15 && y === 8 ? [0, 0, 1] : [0, 0, 0]), { filter });
      expect(pngFlatColour(file)).toBeNull();
    }
    expect(pngFlatColour(png("window.png", 64, 48, (x, y) => [x * 4, y * 5, 30]))).toBeNull();
  });

  it("rejects a file that is not a PNG instead of passing it", () => {
    const file = join(dir, "junk.png");
    writeFileSync(file, "not a png");
    expect(() => pngFlatColour(file)).toThrow(/not a PNG/);
  });
});

describe("test app isolation", () => {
  it("keeps the test app's data folder apart from the installed app's", () => {
    const dir = e2eDataDir(join(tmpdir(), "hermes-test-home"));
    expect(dir).toContain(E2E_IDENTIFIER);
    expect(dir.endsWith(".e2e")).toBe(true);
    expect(dir).not.toMatch(/com\.hermes-ide\.terminal[\\/]/);
  });

  it("does not hand a surrounding Hermes or agent session on to the app", () => {
    process.env.HERMES_SESSION_ID = "outer";
    process.env.CLAUDE_CODE_TEST = "1";
    process.env.CLAUDECODE = "1";
    process.env.HERMES_E2E_KEEP = "x";
    process.env.PLAIN_VAR = "kept";
    try {
      const env = inheritedEnv();
      expect(env.PLAIN_VAR).toBe("kept");
      expect(env).not.toHaveProperty("HERMES_SESSION_ID");
      expect(env).not.toHaveProperty("HERMES_E2E_KEEP");
      expect(env).not.toHaveProperty("CLAUDE_CODE_TEST");
      expect(env).not.toHaveProperty("CLAUDECODE");
    } finally {
      for (const k of ["HERMES_SESSION_ID", "CLAUDE_CODE_TEST", "CLAUDECODE", "HERMES_E2E_KEEP", "PLAIN_VAR"]) delete process.env[k];
    }
  });
});

// Scenarios that prove something "on next launch" relaunch the app against
// the same data: homeDir (private home) and resetData: false (real home).
describe("prepareAppHome", () => {
  let root;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "hermes-prep-home-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("gives each launch its own private home inside its temp folder by default", () => {
    const privateTmp = join(root, "launch-a");
    const { homeEnv, dataDir } = prepareAppHome({ home: "private", privateTmp });
    expect(homeEnv.HOME).toBe(join(privateTmp, "home"));
    expect(existsSync(homeEnv.HOME)).toBe(true);
    expect(dataDir.startsWith(homeEnv.HOME)).toBe(true);
    expect(dataDir.endsWith(E2E_IDENTIFIER)).toBe(true);
  });

  it("reuses a given private home across launches and keeps what the last launch wrote", () => {
    const homeDir = join(root, "shared-home");
    const first = prepareAppHome({ home: "private", homeDir, privateTmp: join(root, "launch-1") });
    mkdirSync(first.dataDir, { recursive: true });
    writeFileSync(join(first.dataDir, "marker"), "from launch 1");

    const second = prepareAppHome({ home: "private", homeDir, privateTmp: join(root, "launch-2") });
    expect(second.homeEnv.HOME).toBe(homeDir);
    expect(second.homeEnv.XDG_DATA_HOME).toBe(join(homeDir, ".local", "share"));
    expect(second.dataDir).toBe(first.dataDir);
    expect(readFileSync(join(second.dataDir, "marker"), "utf8")).toBe("from launch 1");
  });

  it("wipes the test app's data before a real-home launch unless told to keep it", () => {
    let resets = 0;
    const reset = () => {
      resets += 1;
    };
    const fresh = prepareAppHome({ home: "real", privateTmp: root, reset });
    expect(resets).toBe(1);
    expect(fresh.homeEnv).toEqual({});
    expect(fresh.dataDir).toBe(e2eDataDir());

    const kept = prepareAppHome({ home: "real", resetData: false, privateTmp: root, reset });
    expect(resets).toBe(1);
    expect(kept.dataDir).toBe(e2eDataDir());
  });
});

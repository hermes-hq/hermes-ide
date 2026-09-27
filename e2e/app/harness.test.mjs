// Behavioural tests for the harness's bridge client against a stand-in
// bridge server: the token travels with every request, refusals surface as
// errors, script failures inside the app become errors, and waits poll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge, e2eDataDir, inheritedEnv, E2E_IDENTIFIER } from "./harness.mjs";

const TOKEN = "t".repeat(64);
let server;
let port;
const seen = [];
let evalResponses = [];

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
      if (req.url === "/screenshot") return reply(500, { ok: false, error: "no window" });
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
      await expect(bridge.screenshot(join(dir, "shot.png"))).rejects.toThrow(/500.*no window/);
      expect(existsSync(join(dir, "shot.png"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

/**
 * The first message to a newly started bridge must reach Claude at once.
 *
 * The Claude CLI reports its `system/init` only after it has the first user
 * message and has run the UserPromptSubmit hook, so anything in the bridge
 * that holds that message (or the hook) until init can only time out.
 *
 * Runs the real bridge against a stand-in SDK that behaves like the CLI:
 * it reads a user message, runs UserPromptSubmit, then reports init.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const bridge = fileURLToPath(
  new URL("../../src-tauri/bridge/hermes-claude-bridge.mjs", import.meta.url),
);
const dir = mkdtempSync(join(tmpdir(), "hermes-bridge-latency-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fakeSdk = join(dir, "fake-sdk.mjs");
writeFileSync(
  fakeSdk,
  `
export const tool = (name) => ({ name });
export const createSdkMcpServer = (o) => o;
export function query({ prompt, options }) {
  async function* run() {
    for await (const _msg of prompt) {
      for (const m of options.hooks.UserPromptSubmit) {
        for (const h of m.hooks) await h({ hook_event_name: "UserPromptSubmit" });
      }
      yield { type: "system", subtype: "init", model: "fake-model" };
      yield { type: "result", subtype: "success" };
    }
  }
  const it = run();
  it.accountInfo = async () => ({});
  return it;
}
`,
);
const hooks = join(dir, "hooks.mjs");
writeFileSync(
  hooks,
  `
export async function resolve(spec, ctx, next) {
  if (spec === "@anthropic-ai/claude-agent-sdk") {
    return { url: ${JSON.stringify(pathToFileURL(fakeSdk).href)}, shortCircuit: true };
  }
  return next(spec, ctx);
}
`,
);
const register = join(dir, "register.mjs");
writeFileSync(
  register,
  `import { register } from "node:module";
register(${JSON.stringify(pathToFileURL(hooks).href)});
`,
);

describe("bridge first message", () => {
  it("is answered without waiting for an init that only it can bring", async () => {
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(register).href, bridge, "--working-dir", dir, "--session-id", "s1"],
      { cwd: dir, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const elapsed = await new Promise<number>((resolve, reject) => {
      let buf = "";
      let sentAt = 0;
      child.stdout.on("data", (d) => {
        buf += d;
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (JSON.parse(line).type === "result") resolve(Date.now() - sentAt);
        }
      });
      child.on("exit", (code) => reject(new Error(`bridge exited ${code}: ${stderr}`)));
      sentAt = Date.now();
      child.stdin.write(
        JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n",
      );
    }).finally(() => child.kill("SIGKILL"));
    expect(elapsed).toBeLessThan(1000);
  }, 15000);
});

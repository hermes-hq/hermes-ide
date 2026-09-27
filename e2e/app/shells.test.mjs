// Behavioural tests for shells.mjs: the command lines it builds are run by
// real shells (each one that exists on this machine), with paths that contain
// spaces and quotes, and the exit code is read back the way a scenario does.
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROBE_OUTPUT, classifyProbe, commandLine, echoExitCode, probeCommand, quote } from "./shells.mjs";

const has = (cmd) => spawnSync(cmd, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status === 0;
const POSIX = process.platform !== "win32";
const PWSH = ["pwsh", "powershell"].find(has);
const CMD = process.platform === "win32";

// A folder whose name has a space and a single quote, like
// "C:\Program Files\..." or "~/Library/Application Support/...".
const root = mkdtempSync(join(tmpdir(), "shells test "));
const dir = join(root, "it's here");
mkdirSync(dir);
const script = join(dir, "print args.mjs");
writeFileSync(
  script,
  'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n"); process.exit(Number(process.argv[3]));\n',
);
const logPath = join(dir, "run log.jsonl");
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Run lines one after another in `shell`, like a person typing them. */
function typeInto(shell, lines) {
  if (shell === "posix") return spawnSync("sh", [], { input: lines.join("\n") + "\n", encoding: "utf8" });
  if (shell === "powershell") return spawnSync(PWSH, ["-NoProfile", "-Command", lines.join("\n")], { encoding: "utf8" });
  return spawnSync("cmd.exe", ["/d", "/q", "/k"], { input: lines.join("\r\n") + "\r\nexit\r\n", encoding: "utf8" });
}

function runsWithExitCode(shell) {
  const run = commandLine(shell, process.execPath, [script, "--code", "3", "--log", logPath]);
  const out = typeInto(shell, [run, echoExitCode(shell, "exit=")]);
  const lines = out.stdout.split(/\r?\n/).map((l) => l.trim());
  expect(lines).toContain(JSON.stringify(["--code", "3", "--log", logPath]));
  expect(lines).toContain("exit=3");
}

function probes(shell) {
  const out = typeInto(shell, [probeCommand()]);
  const line = out.stdout.split(/\r?\n/).find((l) => PROBE_OUTPUT.test(l));
  expect(line, out.stdout).toBeDefined();
  expect(classifyProbe(line)).toBe(shell);
}

describe("shells", () => {
  it("tells the three shells apart from the probe's output", () => {
    expect(classifyProbe("hermes-shell-probe-0")).toBe("posix");
    expect(classifyProbe("hermes-shell-probe-130  ")).toBe("posix");
    expect(classifyProbe("hermes-shell-probe-True")).toBe("powershell");
    expect(classifyProbe('"hermes-shell-probe-$?"')).toBe("cmd");
    expect(() => classifyProbe("hermes-shell-probe-what")).toThrow(/could not tell/);
  });

  it("does not mistake the typed probe command for its output", () => {
    expect(PROBE_OUTPUT.test(`user% ${probeCommand()}`)).toBe(false);
    expect(PROBE_OUTPUT.test(`PS C:\\> ${probeCommand()}`)).toBe(false);
    expect(PROBE_OUTPUT.test("hermes-shell-probe-0")).toBe(true);
  });

  it("refuses shells it does not know and cmd arguments with a double quote", () => {
    expect(() => quote("fish", "x")).toThrow(/unknown shell/);
    expect(() => echoExitCode("fish", "x")).toThrow(/unknown shell/);
    expect(() => quote("cmd", 'a"b')).toThrow(/double quote/);
  });

  it.runIf(POSIX)("POSIX shell: runs paths with spaces and quotes and reads the exit code", () => runsWithExitCode("posix"));
  it.runIf(POSIX)("POSIX shell: the probe says posix", () => probes("posix"));
  it.runIf(PWSH)("PowerShell: runs paths with spaces and quotes and reads the exit code", () => runsWithExitCode("powershell"));
  it.runIf(PWSH)("PowerShell: the probe says powershell", () => probes("powershell"));
  it.runIf(CMD)("cmd.exe: runs paths with spaces and reads the exit code", () => runsWithExitCode("cmd"));
  it.runIf(CMD)("cmd.exe: the probe says cmd", () => probes("cmd"));
});

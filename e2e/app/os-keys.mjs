// Real OS key presses for scenarios that must prove what the OS keyboard path
// does (native menu accelerators, the webview's own key handling). Everything
// else in the rig types through the DOM on purpose; this is the exception.
//
//   Linux:   xdotool (XTEST) against the app window — run under Xvfb.
//   Windows: SendInput from a small PowerShell/C# helper.
//
// These press keys on the machine, so they run ONLY on CI runners, where
// nobody is using the keyboard: they refuse to run on macOS, and anywhere
// without CI=true.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { IS_CI, sleep } from "./harness.mjs";

export function osKeysAvailable() {
  return IS_CI && (platform() === "linux" || platform() === "win32");
}

function refuseUnlessAllowed() {
  if (platform() === "darwin") throw new Error("real OS key presses are never sent on macOS");
  if (!IS_CI) throw new Error("real OS key presses only run on CI runners (CI=true)");
  if (platform() !== "linux" && platform() !== "win32") throw new Error(`no OS key driver for ${platform()}`);
}

/**
 * Press chords on the real keyboard path of the app window owned by `pid`.
 * `chords` are xdotool-style names: "ctrl+d", "ctrl+shift+d".
 * Returns diagnostics (which window, whether it had focus).
 */
/**
 * `clickAt` ({ x, y, innerWidth, innerHeight, dpr } in page coordinates):
 * first click there with the real mouse, like a person clicking into the
 * terminal, so the webview itself has keyboard focus.
 */
export async function pressChords(pid, chords, { delayMs = 150, clickAt = null } = {}) {
  refuseUnlessAllowed();
  for (const c of chords) {
    if (!/^((ctrl|shift|alt)\+)+[a-z]$/.test(c)) throw new Error(`unsupported chord: ${c}`);
  }
  return platform() === "linux" ? pressLinux(pid, chords, delayMs, clickAt) : pressWindows(pid, chords, delayMs, clickAt);
}

// ─── Linux: xdotool ──────────────────────────────────────────────────

function xdotool(args, timeoutMs = 10_000) {
  const res = spawnSync("xdotool", args, { encoding: "utf8", timeout: timeoutMs });
  if (res.error) throw new Error(`xdotool ${args.join(" ")}: ${res.error.message}`);
  return { status: res.status, out: (res.stdout || "").trim(), err: (res.stderr || "").trim() };
}

async function linuxWindow(pid) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const byPid = xdotool(["search", "--onlyvisible", "--pid", String(pid)]);
    const ids = byPid.out.split(/\s+/).filter(Boolean);
    if (ids.length) return ids[ids.length - 1];
    const byName = xdotool(["search", "--onlyvisible", "--name", "Hermes IDE"]);
    const named = byName.out.split(/\s+/).filter(Boolean);
    if (named.length) return named[named.length - 1];
    await sleep(250);
  }
  throw new Error(`no visible X window for pid ${pid}`);
}

async function pressLinux(pid, chords, delayMs, clickAt) {
  const win = await linuxWindow(pid);
  // No window manager under Xvfb: give the window input focus directly.
  xdotool(["windowfocus", win]);
  await sleep(200);
  let clicked = null;
  if (clickAt) {
    // The webview sits below the menu bar: offset page coordinates by the
    // difference between the window and the page.
    const geo = Object.fromEntries(
      xdotool(["getwindowgeometry", "--shell", win]).out.split("\n").map((l) => l.split("=")),
    );
    const x = Math.round(clickAt.x * clickAt.dpr + (Number(geo.WIDTH) - clickAt.innerWidth * clickAt.dpr));
    const y = Math.round(clickAt.y * clickAt.dpr + (Number(geo.HEIGHT) - clickAt.innerHeight * clickAt.dpr));
    const res = xdotool(["mousemove", "--window", win, String(x), String(y), "click", "1"]);
    if (res.status !== 0) throw new Error(`xdotool click failed: ${res.err}`);
    clicked = { x, y, window: `${geo.WIDTH}x${geo.HEIGHT}` };
    await sleep(300);
  }
  const focused = xdotool(["getwindowfocus"]).out;
  const res = xdotool(["key", "--clearmodifiers", "--delay", String(delayMs), ...chords], 60_000);
  if (res.status !== 0) throw new Error(`xdotool key failed: ${res.err}`);
  return { driver: "xdotool", window: win, focusedWindow: focused, clicked, sent: chords.length };
}

// ─── Windows: SendInput ──────────────────────────────────────────────

const PS_SCRIPT = String.raw`
param([int]$ProcId, [string]$Chords, [int]$DelayMs = 150, [int]$ClickX = -1, [int]$ClickY = -1)
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class HermesKeys {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);

  public static string Click(IntPtr h, int x, int y) {
    var p = new POINT();
    p.X = x;
    p.Y = y;
    ClientToScreen(h, ref p);
    SetCursorPos(p.X, p.Y);
    var down = new INPUT();
    down.type = 0;
    down.u.mi.dwFlags = 0x0002;
    var up = new INPUT();
    up.type = 0;
    up.u.mi.dwFlags = 0x0004;
    SendInput(2, new INPUT[] { down, up }, Marshal.SizeOf(typeof(INPUT)));
    return p.X + "," + p.Y;
  }

  static INPUT Key(ushort vk, bool up) {
    var i = new INPUT();
    i.type = 1;
    i.u.ki.wVk = vk;
    i.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
    i.u.ki.dwFlags = up ? 2u : 0u;
    return i;
  }

  public static uint Chord(ushort[] mods, ushort key) {
    var list = new List<INPUT>();
    foreach (var m in mods) list.Add(Key(m, false));
    list.Add(Key(key, false));
    list.Add(Key(key, true));
    for (int k = mods.Length - 1; k >= 0; k--) list.Add(Key(mods[k], true));
    var arr = list.ToArray();
    return SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
  }

  public static bool Focus(IntPtr h) {
    if (GetForegroundWindow() == h) return true;
    uint ignored;
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
    uint me = GetCurrentThreadId();
    if (fgThread != 0 && fgThread != me) AttachThreadInput(me, fgThread, true);
    ShowWindow(h, 9);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    if (fgThread != 0 && fgThread != me) AttachThreadInput(me, fgThread, false);
    return GetForegroundWindow() == h;
  }
}
"@

$h = [IntPtr]::Zero
for ($i = 0; $i -lt 50 -and $h -eq [IntPtr]::Zero; $i++) {
  $h = (Get-Process -Id $ProcId).MainWindowHandle
  if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 200 }
}
if ($h -eq [IntPtr]::Zero) { throw "process $ProcId has no main window" }

$focused = $false
for ($i = 0; $i -lt 10 -and -not $focused; $i++) {
  $focused = [HermesKeys]::Focus($h)
  if (-not $focused) { Start-Sleep -Milliseconds 300 }
}
if (-not $focused) { throw "could not bring the app window to the foreground" }
Start-Sleep -Milliseconds 300
$clicked = ""
if ($ClickX -ge 0) {
  $clicked = [HermesKeys]::Click($h, $ClickX, $ClickY)
  Start-Sleep -Milliseconds 300
}

$sent = 0
foreach ($c in $Chords.Split(',')) {
  $parts = $c.Split('+')
  $mods = New-Object System.Collections.Generic.List[uint16]
  for ($k = 0; $k -lt $parts.Length - 1; $k++) {
    switch ($parts[$k]) {
      'ctrl' { $mods.Add([uint16]0x11) }
      'shift' { $mods.Add([uint16]0x10) }
      'alt' { $mods.Add([uint16]0x12) }
    }
  }
  $key = [uint16][char]($parts[$parts.Length - 1].ToUpper())
  $n = [HermesKeys]::Chord($mods.ToArray(), $key)
  if ($n -eq 0) { throw "SendInput sent nothing for $c" }
  $sent++
  Start-Sleep -Milliseconds $DelayMs
}
Write-Output ("{""window"":""" + $h + """,""focused"":true,""clicked"":""" + $clicked + """,""sent"":" + $sent + "}")
`;

function pressWindows(pid, chords, delayMs, clickAt) {
  // The webview fills the client area; the menu bar is outside it.
  const click = clickAt
    ? ["-ClickX", String(Math.round(clickAt.x * clickAt.dpr)), "-ClickY", String(Math.round(clickAt.y * clickAt.dpr))]
    : [];
  const dir = mkdtempSync(join(tmpdir(), "hermes-e2e-keys-"));
  const script = join(dir, "press.ps1");
  writeFileSync(script, PS_SCRIPT);
  try {
    const res = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-ProcId", String(pid), "-Chords", chords.join(","), "-DelayMs", String(delayMs), ...click],
      { encoding: "utf8", timeout: 120_000 },
    );
    if (res.status !== 0) throw new Error(`SendInput helper failed (status ${res.status}): ${res.stderr || res.stdout}`);
    const line = (res.stdout || "").trim().split(/\r?\n/).pop();
    return { driver: "SendInput", ...JSON.parse(line) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

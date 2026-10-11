// CPU time a process has used so far, in seconds, for scenarios that compare
// idle CPU over a few seconds (QA-review-track-big-files).
//
// `ps -o time=` is fine-grained only on macOS (M:SS.cc). procps on Linux
// prints whole seconds ([DD-]HH:MM:SS), so over an 8 s window one tick across
// a second boundary reads as 12.5 % of a core. Linux reads the clock ticks
// from /proc/<pid>/stat instead.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** `ps -o time=`: [DD-]HH:MM:SS or M:SS.cc, in seconds. */
export function parsePsTime(text) {
  const [days, clock] = text.trim().includes("-") ? text.trim().split("-") : ["0", text.trim()];
  return Number(days) * 86_400 + clock
    .split(":")
    .map(Number)
    .reduce((acc, part) => acc * 60 + part, 0);
}

/** /proc/<pid>/stat: utime + stime (fields 14 and 15), in seconds. */
export function parseProcStat(text, ticksPerSecond) {
  // The command name (field 2) is in parentheses and may hold spaces or ")".
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return (Number(fields[11]) + Number(fields[12])) / ticksPerSecond;
}

let ticks;
export function cpuSeconds(pid) {
  if (process.platform === "linux") {
    ticks ??= Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) || 100;
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"), ticks);
  }
  return parsePsTime(execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }));
}

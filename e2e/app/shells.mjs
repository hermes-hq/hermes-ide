// Typing commands into a terminal session whose shell a scenario does not
// choose: a POSIX shell on macOS and Linux, PowerShell or cmd.exe on Windows.
// Scenarios ask the shell what it is (probeCommand + classifyProbe), then
// build command lines and read exit codes the way that shell does.

const PROBE = "hermes-shell-probe-";

/**
 * `echo "<probe>$?"` prints the last exit status in a POSIX shell (a number),
 * True/False in PowerShell, and the text unchanged, quotes included, in cmd.
 */
export const probeCommand = () => `echo "${PROBE}$?"`;

/** Matches the probe's output line (and not the line the command was typed on). */
export const PROBE_OUTPUT = new RegExp(`^"?${PROBE}\\S*\\s*$`);

/** "posix", "powershell" or "cmd" from the probe's output line. */
export function classifyProbe(line) {
  const value = line.trim().replace(/^"/, "").replace(/"$/, "").slice(PROBE.length);
  if (/^\d+$/.test(value)) return "posix";
  if (/^(True|False)$/.test(value)) return "powershell";
  if (value === "$?") return "cmd";
  throw new Error(`could not tell which shell printed "${line.trim()}"`);
}

/** Quote one argument (paths may contain spaces or quotes). */
export function quote(shell, arg) {
  if (shell === "posix") return `'${arg.replaceAll("'", "'\\''")}'`;
  if (shell === "powershell") return `'${arg.replaceAll("'", "''")}'`;
  if (shell === "cmd") {
    // A Windows path cannot contain a double quote; refuse anything that does.
    if (arg.includes('"')) throw new Error(`cmd.exe argument with a double quote: ${arg}`);
    return `"${arg}"`;
  }
  throw new Error(`unknown shell: ${shell}`);
}

/** The command line that runs `program` with `args`; flags stay unquoted. */
export function commandLine(shell, program, args = []) {
  const words = [quote(shell, program), ...args.map((a) => (/^--?[a-z][a-z-]*$/.test(a) ? a : quote(shell, a)))];
  // PowerShell runs a quoted program path only through the call operator.
  return (shell === "powershell" ? "& " : "") + words.join(" ");
}

/** A command that prints `marker` followed by the last command's exit code. */
export function echoExitCode(shell, marker) {
  if (shell === "posix") return `echo ${marker}$?`;
  if (shell === "powershell") return `echo "${marker}$LASTEXITCODE"`;
  if (shell === "cmd") return `echo ${marker}%ERRORLEVEL%`;
  throw new Error(`unknown shell: ${shell}`);
}

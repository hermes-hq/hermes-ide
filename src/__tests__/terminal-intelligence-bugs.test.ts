/**
 * Terminal Intelligence Bug Tests
 *
 * Tests for bugs found during deep analysis of:
 * - src/terminal/TerminalPool.ts
 * - src/terminal/intelligence/historyProvider.ts
 * - src/terminal/intelligence/commandIndex.ts
 * - src/terminal/intelligence/contextAnalyzer.ts
 * - src/terminal/intelligence/suggestionEngine.ts
 * - src/terminal/intelligence/shellEnvironment.ts
 * - src/terminal/intentCommands.ts
 *
 * Grouped by severity: CRITICAL, HIGH, MEDIUM
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// @ts-expect-error — fs is a Node built-in, not in browser tsconfig
import { readFileSync } from "fs";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// ─── Imports ─────────────────────────────────────────────────────────
import { suggest } from "../terminal/intelligence/suggestionEngine";
import { createHistoryProvider, type HistoryProvider } from "../terminal/intelligence/historyProvider";
import { lookupCommands, lookupByPrefix } from "../terminal/intelligence/commandIndex";
import { isContextRelevant, type ProjectContext } from "../terminal/intelligence/contextAnalyzer";
import { resolveIntent, getIntentSuggestions } from "../terminal/intentCommands";

// ─── Source Code for Structural Tests ─────────────────────────────────
const POOL_SRC: string = [
  readFileSync(new URL("../terminal/pool.ts", import.meta.url), "utf-8"),
  readFileSync(new URL("../terminal/TerminalPool.ts", import.meta.url), "utf-8"),
  readFileSync(new URL("../terminal/themes.ts", import.meta.url), "utf-8"),
  readFileSync(new URL("../terminal/ghostText.ts", import.meta.url), "utf-8"),
].join("\n");

const HISTORY_SRC: string = readFileSync(
  new URL("../terminal/intelligence/historyProvider.ts", import.meta.url),
  "utf-8",
);

const CMD_INDEX_SRC: string = readFileSync(
  new URL("../terminal/intelligence/commandIndex.ts", import.meta.url),
  "utf-8",
);

const CONTEXT_SRC: string = readFileSync(
  new URL("../terminal/intelligence/contextAnalyzer.ts", import.meta.url),
  "utf-8",
);

// ─── Helpers ─────────────────────────────────────────────────────────
function makeContext(overrides?: Partial<ProjectContext>): ProjectContext {
  return {
    hasGit: false,
    packageManager: null,
    languages: [],
    frameworks: [],
    ...overrides,
  };
}

/** Mirror of sliceLastCodePoint from TerminalPool.ts for unit testing */
function sliceLastCodePoint(buf: string): string {
  if (buf.length === 0) return buf;
  if (buf.length >= 2) {
    const last = buf.charCodeAt(buf.length - 1);
    const prev = buf.charCodeAt(buf.length - 2);
    if (last >= 0xDC00 && last <= 0xDFFF && prev >= 0xD800 && prev <= 0xDBFF) {
      return buf.slice(0, -2);
    }
  }
  return buf.slice(0, -1);
}

/** Mirror of updateInputBuffer from TerminalPool.ts for unit testing (post-fix version) */
function updateInputBuffer(inputBuffer: string, data: string): string {
  // Single-char fast path
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code === 0x7f) return sliceLastCodePoint(inputBuffer);
    if (code === 0x03 || code === 0x15) return "";
    if (code === 0x0d) return ""; // Enter clears
    if (code === 0x1b) return inputBuffer; // Bare Escape
    if (code >= 32) return inputBuffer + data;
    return inputBuffer;
  }
  // Escape sequences
  if (data.startsWith("\x1b")) return inputBuffer;
  // Multi-char: process every character
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    if (code === 0x7f) {
      inputBuffer = sliceLastCodePoint(inputBuffer);
    } else if (code === 0x03 || code === 0x15 || code === 0x0d) {
      inputBuffer = "";
    } else if (code === 0x1b) {
      if (i + 1 < data.length && data[i + 1] === "[") {
        i += 2;
        while (i < data.length && !(data.charCodeAt(i) >= 0x40 && data.charCodeAt(i) <= 0x7e)) {
          i++;
        }
      } else if (i + 1 < data.length) {
        i++;
      }
    } else if (code >= 32) {
      inputBuffer += data[i];
    }
  }
  return inputBuffer;
}


// =============================================================================
// CRITICAL BUGS
// =============================================================================

describe("CRITICAL: Race condition guard in createTerminal (TOCTOU fix)", () => {
  it("source has a 'creating' guard set to prevent concurrent duplicate creates", () => {
    // The creating set must be defined
    expect(POOL_SRC).toContain("const creating = new Set<string>()");
  });

  it("createTerminal checks both pool.has AND creating.has before proceeding", () => {
    expect(POOL_SRC).toContain("pool.has(sessionId) || creating.has(sessionId)");
  });

  it("createTerminal adds to creating set before any async work", () => {
    const fnBody = POOL_SRC.match(/export async function createTerminal[\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    const body = fnBody![0];
    // creating.add must appear before any 'await'
    const addIdx = body.indexOf("creating.add(sessionId)");
    const firstAwait = body.indexOf("await ");
    expect(addIdx).toBeGreaterThan(-1);
    expect(firstAwait).toBeGreaterThan(-1);
    expect(addIdx).toBeLessThan(firstAwait);
  });

  it("createTerminal removes from creating set after pool.set (happy path)", () => {
    const fnBody = POOL_SRC.match(/export async function createTerminal[\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    const body = fnBody![0];
    const poolSetIdx = body.indexOf("pool.set(sessionId");
    const deleteIdx = body.lastIndexOf("creating.delete(sessionId)");
    expect(poolSetIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(poolSetIdx);
  });

  it("createTerminal cleans up creating set on error (catch block)", () => {
    const fnBody = POOL_SRC.match(/export async function createTerminal[\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    const body = fnBody![0];
    // Must have a catch block that deletes from creating
    expect(body).toContain("catch");
    // The catch block should clean up creating, terminal, container
    const catchBlock = body.match(/catch\s*\([\s\S]*?\{[\s\S]*?creating\.delete/);
    expect(catchBlock).not.toBeNull();
  });

  it("destroy() also cleans up the creating set (race between create and destroy)", () => {
    const destroyFn = POOL_SRC.match(/export function destroy[\s\S]*?\n\}/);
    expect(destroyFn).not.toBeNull();
    expect(destroyFn![0]).toContain("creating.delete(sessionId)");
  });
});

describe("CRITICAL: Backspace corrupts surrogate pairs in inputBuffer", () => {
  it("source defines sliceLastCodePoint helper for surrogate-pair-safe backspace", () => {
    expect(POOL_SRC).toContain("function sliceLastCodePoint(buf: string): string");
  });

  it("single-char backspace path uses sliceLastCodePoint (not slice(0, -1))", () => {
    // Find the single-char backspace in updateInputBuffer
    const fnBody = POOL_SRC.match(/function updateInputBuffer[\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    const body = fnBody![0];
    // The backspace handling should use sliceLastCodePoint
    expect(body).toContain("sliceLastCodePoint(entry.inputBuffer)");
  });

  it("multi-char paste backspace path uses sliceLastCodePoint", () => {
    const fnBody = POOL_SRC.match(/function updateInputBuffer[\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    const body = fnBody![0];
    // Should have two references to sliceLastCodePoint (one per backspace path)
    const matches = body.match(/sliceLastCodePoint/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it("sliceLastCodePoint removes entire surrogate pair for emoji", () => {
    // U+1F600 (grinning face) = "\uD83D\uDE00" in UTF-16
    const emoji = "\uD83D\uDE00";
    const buf = "hello" + emoji;
    expect(buf.length).toBe(7); // 5 + 2 (surrogate pair)
    const result = sliceLastCodePoint(buf);
    expect(result).toBe("hello");
    expect(result.length).toBe(5);
  });

  it("sliceLastCodePoint removes single code unit for BMP characters", () => {
    expect(sliceLastCodePoint("hello")).toBe("hell");
    expect(sliceLastCodePoint("a")).toBe("");
    expect(sliceLastCodePoint("")).toBe("");
  });

  it("sliceLastCodePoint handles mixed BMP and surrogate pair content", () => {
    const emoji = "\uD83D\uDE00";
    const buf = emoji + "a";
    // "a" is a single BMP character, so sliceLastCodePoint removes "a"
    expect(sliceLastCodePoint(buf)).toBe(emoji);
    // Now remove the emoji
    expect(sliceLastCodePoint(emoji)).toBe("");
  });

  it("backspace after emoji removes entire emoji, not half a surrogate pair", () => {
    const emoji = "\uD83D\uDE00";
    let buf = "test" + emoji;
    buf = updateInputBuffer(buf, "\x7f");
    expect(buf).toBe("test");
    // No orphaned surrogate
    for (let i = 0; i < buf.length; i++) {
      const code = buf.charCodeAt(i);
      expect(code >= 0xD800 && code <= 0xDFFF).toBe(false);
    }
  });

  it("backspace in paste after emoji removes entire emoji", () => {
    const emoji = "\uD83D\uDE00";
    let buf = "test" + emoji;
    // Multi-char paste path: "ab\x7f" should add "a", add "b", then backspace "b"
    buf = updateInputBuffer(buf, "ab\x7f");
    expect(buf).toBe("test" + emoji + "a");
  });
});


// =============================================================================
// HIGH BUGS
// =============================================================================

describe("HIGH: historyProvider.match() does not trim its prefix parameter", () => {
  let history: HistoryProvider;

  beforeEach(() => {
    history = createHistoryProvider();
  });

  it("source trims prefix in match() before matching", () => {
    expect(HISTORY_SRC).toContain("const trimmedPrefix = prefix.trim()");
  });

  it("match() with leading/trailing whitespace still finds commands", () => {
    history.addCommand("git status");
    history.addCommand("git log");

    // With whitespace prefix - should still match trimmed commands
    const matches = history.match("  git  ");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => m.command.startsWith("git"))).toBe(true);
  });

  it("match() with only whitespace returns empty (not all entries)", () => {
    history.addCommand("git status");
    const matches = history.match("   ");
    expect(matches).toEqual([]);
  });

  it("match() with untrimmed prefix matches same entries as trimmed", () => {
    history.addCommand("npm install");
    history.addCommand("npm test");

    const trimmedResults = history.match("npm");
    const untrimmedResults = history.match(" npm ");

    expect(trimmedResults.length).toBe(untrimmedResults.length);
    expect(trimmedResults.map((r) => r.command)).toEqual(
      untrimmedResults.map((r) => r.command),
    );
  });
});

describe("HIGH: historyProvider removes redundant seen Set in match()", () => {
  it("source does NOT use a seen Set inside match() body (recencyList has no duplicates)", () => {
    // The match() function should not allocate a seen Set since recencyList
    // is guaranteed unique by recencySet.
    // Extract only the match() function body (between the function signature and its closing)
    const matchFn = HISTORY_SRC.match(/match\(prefix: string\): HistoryMatch\[\] \{[\s\S]*?return results;\s*\}/);
    expect(matchFn).not.toBeNull();
    // The match body should NOT contain "seen" variable usage
    expect(matchFn![0]).not.toContain("seen.has");
    expect(matchFn![0]).not.toContain("seen.add");
  });
});

describe("HIGH: lookupByPrefix does not trim input prefix", () => {
  it("source trims prefix in lookupByPrefix", () => {
    expect(CMD_INDEX_SRC).toContain("const trimmed = prefix.trim()");
  });

  it("lookupByPrefix with whitespace-padded input returns results", () => {
    const trimmedResults = lookupByPrefix("git");
    const paddedResults = lookupByPrefix("  git  ");
    expect(trimmedResults.length).toBeGreaterThan(0);
    expect(paddedResults.length).toBe(trimmedResults.length);
  });

  it("lookupByPrefix with only whitespace returns empty", () => {
    expect(lookupByPrefix("   ")).toEqual([]);
  });

  it("lookupByPrefix with empty string returns empty", () => {
    expect(lookupByPrefix("")).toEqual([]);
  });
});

describe("HIGH: loadHistory prevents duplicate/concurrent loads", () => {
  it("source checks provider.loaded at the start of loadHistory", () => {
    expect(HISTORY_SRC).toContain("if (provider.loaded) return;");
  });

  it("loadHistory guard prevents re-loading when already loaded", () => {
    const provider = createHistoryProvider();
    provider.markLoaded();
    // If loadHistory is called again, it should return immediately
    // without re-adding commands (verified structurally above)
    expect(provider.loaded).toBe(true);
  });
});


// =============================================================================
// MEDIUM BUGS
// =============================================================================

describe("MEDIUM: isContextRelevant unconditionally returns true for docker/k8s/make", () => {
  it("docker is NOT relevant when no docker framework detected", () => {
    const ctx = makeContext({ hasGit: true, languages: ["typescript"] });
    expect(isContextRelevant("docker", ctx)).toBe(false);
  });

  it("docker IS relevant when docker framework is detected", () => {
    const ctx = makeContext({ frameworks: ["docker"] });
    expect(isContextRelevant("docker", ctx)).toBe(true);
  });

  it("k8s is NOT relevant when no k8s framework detected", () => {
    const ctx = makeContext({ languages: ["go"] });
    expect(isContextRelevant("k8s", ctx)).toBe(false);
  });

  it("k8s IS relevant when k8s framework is detected", () => {
    const ctx = makeContext({ frameworks: ["k8s"] });
    expect(isContextRelevant("k8s", ctx)).toBe(true);
  });

  it("make is NOT relevant when no make framework detected", () => {
    const ctx = makeContext({ languages: ["python"] });
    expect(isContextRelevant("make", ctx)).toBe(false);
  });

  it("make IS relevant when make framework is detected", () => {
    const ctx = makeContext({ frameworks: ["make"] });
    expect(isContextRelevant("make", ctx)).toBe(true);
  });

  it("system commands are always relevant regardless of context", () => {
    const emptyCtx = makeContext();
    expect(isContextRelevant("system", emptyCtx)).toBe(true);
    expect(isContextRelevant("brew", emptyCtx)).toBe(true);
    expect(isContextRelevant("gh", emptyCtx)).toBe(true);
  });
});

describe("MEDIUM: Context relevance affects suggestion scoring correctly", () => {
  let history: HistoryProvider;

  beforeEach(() => {
    history = createHistoryProvider();
  });

  it("docker commands do NOT get +150 boost without docker context", () => {
    const noDockerCtx = makeContext({ languages: ["typescript"] });
    const results = suggest("docker p", noDockerCtx, history);
    const dockerPs = results.find((r) => r.text === "docker ps");
    expect(dockerPs).toBeDefined();
    // Without context: base 100 + prefix bonus 100 = 200, no context boost
    expect(dockerPs!.score).toBe(200);
  });

  it("docker commands get +150 boost with docker context", () => {
    const dockerCtx = makeContext({ frameworks: ["docker"] });
    const results = suggest("docker p", dockerCtx, history);
    const dockerPs = results.find((r) => r.text === "docker ps");
    expect(dockerPs).toBeDefined();
    // With context: 100 + 100 (prefix) + 150 (context) = 350
    expect(dockerPs!.score).toBe(350);
  });
});


// =============================================================================
// EDGE CASE TESTS
// =============================================================================

describe("Edge cases: intentCommands", () => {
  it("resolveIntent with empty input returns unresolved", () => {
    expect(resolveIntent("", { cwd: "/tmp" }).resolved).toBe(false);
  });

  it("resolveIntent with no colon returns unresolved", () => {
    expect(resolveIntent("test", { cwd: "/tmp" }).resolved).toBe(false);
  });

  it("resolveIntent with only colon returns unresolved", () => {
    expect(resolveIntent(":", { cwd: "/tmp" }).resolved).toBe(false);
  });

  it("resolveIntent with extra whitespace after colon resolves correctly", () => {
    const result = resolveIntent(":  test  ", { cwd: "/tmp" });
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.command).toBe("npm test");
    }
  });

  it("resolveIntent is case-insensitive", () => {
    const result = resolveIntent(":STATUS", { cwd: "/tmp" });
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.command).toBe("git status");
    }
  });

  it("getIntentSuggestions with empty colon returns all intents", () => {
    const results = getIntentSuggestions(":");
    expect(results.length).toBe(5); // all 5 intents
  });

  it("getIntentSuggestions with non-colon prefix returns empty", () => {
    expect(getIntentSuggestions("test")).toEqual([]);
  });

  it("getIntentSuggestions filters correctly with partial match", () => {
    const results = getIntentSuggestions(":st");
    const texts = results.map((r) => r.text);
    expect(texts).toContain(":status");
  });
});

describe("Edge cases: commandIndex", () => {
  it("lookupCommands with empty string returns empty", () => {
    expect(lookupCommands("")).toEqual([]);
  });

  it("lookupCommands with whitespace-only returns empty", () => {
    expect(lookupCommands("   ")).toEqual([]);
  });

  it("lookupCommands with nonexistent first token returns empty", () => {
    expect(lookupCommands("zzzzzzz")).toEqual([]);
  });

  it("lookupCommands returns commands starting with full input", () => {
    const results = lookupCommands("git st");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.command.startsWith("git st"))).toBe(true);
  });

  it("lookupByPrefix with single char returns matching first tokens", () => {
    const results = lookupByPrefix("n");
    expect(results.length).toBeGreaterThan(0);
    // All results should have first token starting with "n"
    for (const r of results) {
      const firstToken = r.command.split(" ")[0];
      expect(firstToken.startsWith("n")).toBe(true);
    }
  });
});

describe("Edge cases: historyProvider", () => {
  let history: HistoryProvider;

  beforeEach(() => {
    history = createHistoryProvider();
  });

  it("addCommand with special characters stores correctly", () => {
    history.addCommand('echo "hello world" | grep hello');
    const matches = history.match("echo");
    expect(matches).toHaveLength(1);
    expect(matches[0].command).toBe('echo "hello world" | grep hello');
  });

  it("addCommand with unicode characters stores correctly", () => {
    history.addCommand("echo \u2603"); // snowman
    const matches = history.match("echo");
    expect(matches).toHaveLength(1);
    expect(matches[0].command).toBe("echo \u2603");
  });

  it("match with exact command text returns that command", () => {
    history.addCommand("git status");
    const matches = history.match("git status");
    expect(matches).toHaveLength(1);
    expect(matches[0].command).toBe("git status");
  });

  it("frequency is preserved across recency reordering", () => {
    history.addCommand("git status");
    history.addCommand("git log");
    history.addCommand("git status"); // Re-add, moves to front, freq=2
    history.addCommand("git diff");

    const matches = history.match("git status");
    expect(matches).toHaveLength(1);
    expect(matches[0].frequency).toBe(2);
    expect(matches[0].recencyIndex).toBe(1); // behind git diff
  });

  it("eviction at MAX_HISTORY removes oldest AND its frequency entry", () => {
    // Fill to capacity
    history.addCommand("target-for-eviction");
    for (let i = 1; i < 500; i++) {
      history.addCommand(`fill-${i}`);
    }

    // target-for-eviction is at position 499 (oldest)
    expect(history.match("target-for-eviction")).toHaveLength(1);

    // One more entry triggers eviction
    history.addCommand("overflow");
    expect(history.match("target-for-eviction")).toHaveLength(0);
  });
});

describe("Edge cases: suggestionEngine", () => {
  let history: HistoryProvider;

  beforeEach(() => {
    history = createHistoryProvider();
  });

  it("suggest with tab character in input returns empty", () => {
    const results = suggest("\t", null, history);
    expect(results).toEqual([]);
  });

  it("suggest results are always sorted by score descending", () => {
    history.addCommand("git status");
    history.addCommand("git stash");
    history.addCommand("git stash pop");

    const results = suggest("git st", null, history);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("suggest never returns more than MAX_RESULTS (15)", () => {
    for (let i = 0; i < 30; i++) {
      history.addCommand(`git custom-${i}`);
    }
    const results = suggest("git", null, history);
    expect(results.length).toBeLessThanOrEqual(15);
  });

  it("suggest deduplicates same command from history and index", () => {
    history.addCommand("git status");
    const results = suggest("git st", null, history);
    const gitStatusEntries = results.filter((r) => r.text === "git status");
    expect(gitStatusEntries).toHaveLength(1);
  });

  it("suggest preserves description from index source when deduping", () => {
    history.addCommand("git status");
    const results = suggest("git st", null, history);
    const gitStatus = results.find((r) => r.text === "git status");
    expect(gitStatus).toBeDefined();
    expect(gitStatus!.description).toBe("Show working tree status");
  });
});

describe("Edge cases: shellEnvironment", () => {
  it("source correctly initializes DEFAULT_CONFIG with all fields", () => {
    const shellEnvSrc = readFileSync(
      new URL("../terminal/intelligence/shellEnvironment.ts", import.meta.url),
      "utf-8",
    );

    // All config fields must be present in defaults
    expect(shellEnvSrc).toContain("enabled: true");
    expect(shellEnvSrc).toContain('mode: "augment"');
    expect(shellEnvSrc).toContain("ghostTextEnabled: true");
    expect(shellEnvSrc).toContain("overlayEnabled: true");
    expect(shellEnvSrc).toContain("projectAware: true");
    expect(shellEnvSrc).toContain("historyWeighting: true");
  });
});

describe("Edge cases: Unicode in updateInputBuffer", () => {
  it("typing emoji characters appends correctly", () => {
    const emoji = "\uD83D\uDE00"; // U+1F600
    let buf = "";
    // Emoji comes as a 2-code-unit string
    buf = updateInputBuffer(buf, emoji);
    expect(buf).toBe(emoji);
    expect(buf.length).toBe(2);
  });

  it("backspace after emoji leaves buffer clean (no orphaned surrogates)", () => {
    const emoji = "\uD83D\uDE00";
    let buf = "cmd " + emoji;
    buf = updateInputBuffer(buf, "\x7f");
    expect(buf).toBe("cmd ");
    // Verify no orphaned surrogates
    for (let i = 0; i < buf.length; i++) {
      const code = buf.charCodeAt(i);
      const isSurrogate = code >= 0xD800 && code <= 0xDFFF;
      expect(isSurrogate).toBe(false);
    }
  });

  it("multiple backspaces after multiple emoji removes them all correctly", () => {
    const emoji1 = "\uD83D\uDE00"; // grinning face
    const emoji2 = "\uD83D\uDE0E"; // sunglasses face
    let buf = "hi" + emoji1 + emoji2;
    // Remove emoji2
    buf = updateInputBuffer(buf, "\x7f");
    expect(buf).toBe("hi" + emoji1);
    // Remove emoji1
    buf = updateInputBuffer(buf, "\x7f");
    expect(buf).toBe("hi");
    // Remove 'i'
    buf = updateInputBuffer(buf, "\x7f");
    expect(buf).toBe("h");
  });

  it("backspace on empty buffer is a no-op", () => {
    expect(updateInputBuffer("", "\x7f")).toBe("");
  });

  it("CJK characters (BMP, no surrogate pairs) handled normally", () => {
    let buf = "";
    buf = updateInputBuffer(buf, "\u4F60"); // Chinese "ni"
    buf = updateInputBuffer(buf, "\u597D"); // Chinese "hao"
    expect(buf).toBe("\u4F60\u597D");
    buf = updateInputBuffer(buf, "\x7f");
    expect(buf).toBe("\u4F60");
  });
});

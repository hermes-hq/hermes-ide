/**
 * Suggestion Engine + History Provider Tests
 *
 * Tests for:
 * - SuggestionEngine: suggest() scoring, dedup, sorting, limits
 * - HistoryProvider: addCommand, match, frequency, recency, eviction
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// ─── Imports ─────────────────────────────────────────────────────────
import { suggest } from "../terminal/intelligence/suggestionEngine";
import { createHistoryProvider, type HistoryProvider } from "../terminal/intelligence/historyProvider";
import { type ProjectContext } from "../terminal/intelligence/contextAnalyzer";

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

// =============================================================================
// HistoryProvider Tests
// =============================================================================
describe("HistoryProvider - createHistoryProvider()", () => {
  let history: HistoryProvider;

  beforeEach(() => {
    history = createHistoryProvider();
  });

  describe("addCommand", () => {
    it("stores frequency correctly", () => {
      history.addCommand("git status");
      const matches = history.match("git status");
      expect(matches).toHaveLength(1);
      expect(matches[0].frequency).toBe(1);
    });

    it("increments frequency on duplicate commands", () => {
      history.addCommand("git status");
      history.addCommand("git status");
      history.addCommand("git status");
      const matches = history.match("git status");
      expect(matches).toHaveLength(1);
      expect(matches[0].frequency).toBe(3);
    });

    it("updates recency - most recent is first (recencyIndex 0)", () => {
      history.addCommand("git status");
      history.addCommand("git log");
      history.addCommand("git diff");

      const matches = history.match("git");
      // git diff was added last, should have recencyIndex 0
      const diff = matches.find((m) => m.command === "git diff");
      const log = matches.find((m) => m.command === "git log");
      const status = matches.find((m) => m.command === "git status");

      expect(diff!.recencyIndex).toBe(0);
      expect(log!.recencyIndex).toBe(1);
      expect(status!.recencyIndex).toBe(2);
    });

    it("duplicate commands move to front of recency list", () => {
      history.addCommand("git status");
      history.addCommand("git log");
      history.addCommand("git diff");
      // Re-add "git status" — should move to front
      history.addCommand("git status");

      const matches = history.match("git");
      const status = matches.find((m) => m.command === "git status");
      const diff = matches.find((m) => m.command === "git diff");
      const log = matches.find((m) => m.command === "git log");

      expect(status!.recencyIndex).toBe(0);
      expect(diff!.recencyIndex).toBe(1);
      expect(log!.recencyIndex).toBe(2);
      // frequency should also have incremented
      expect(status!.frequency).toBe(2);
    });

    it("ignores empty commands", () => {
      history.addCommand("");
      history.addCommand("   ");
      history.addCommand("git status");

      const allMatches = history.match("git");
      expect(allMatches).toHaveLength(1);
      expect(allMatches[0].command).toBe("git status");
    });

    it("trims commands before storing", () => {
      history.addCommand("  git status  ");
      const matches = history.match("git status");
      expect(matches).toHaveLength(1);
      expect(matches[0].command).toBe("git status");
    });
  });

  describe("match()", () => {
    it("returns prefix matches sorted by recency", () => {
      history.addCommand("npm install");
      history.addCommand("npm run dev");
      history.addCommand("npm test");

      const matches = history.match("npm");
      expect(matches).toHaveLength(3);
      // Most recent first
      expect(matches[0].command).toBe("npm test");
      expect(matches[1].command).toBe("npm run dev");
      expect(matches[2].command).toBe("npm install");
    });

    it("returns empty array for empty prefix", () => {
      history.addCommand("git status");
      expect(history.match("")).toEqual([]);
      expect(history.match("   ")).toEqual([]);
    });

    it("only matches commands starting with the prefix", () => {
      history.addCommand("git status");
      history.addCommand("git log");
      history.addCommand("npm install");

      const matches = history.match("git");
      expect(matches).toHaveLength(2);
      expect(matches.every((m) => m.command.startsWith("git"))).toBe(true);
    });

    it("returns no duplicates", () => {
      history.addCommand("git status");
      history.addCommand("git status");
      history.addCommand("git status");

      const matches = history.match("git");
      expect(matches).toHaveLength(1);
    });
  });

  describe("MAX_HISTORY cap (500)", () => {
    it("evicts oldest entries when exceeding 500", () => {
      // Use unique prefixes to avoid prefix-matching collisions
      // "aaa-0" through "aaa-499" then "bbb-0" to trigger eviction
      history.addCommand("evict-target");
      for (let i = 1; i < 500; i++) {
        history.addCommand(`filler-${i}`);
      }

      // Verify evict-target is still present (it's the oldest, index 499)
      let matches = history.match("evict-target");
      expect(matches).toHaveLength(1);

      // Add one more to trigger eviction of the oldest entry
      history.addCommand("overflow-entry");

      // evict-target should have been evicted (it was the oldest)
      matches = history.match("evict-target");
      expect(matches).toHaveLength(0);

      // overflow-entry should be present
      matches = history.match("overflow-entry");
      expect(matches).toHaveLength(1);

      // filler-1 should still be present (second oldest, not yet evicted)
      matches = history.match("filler-1 ");
      // Use exact match via a unique query — filler-1 is unique enough
      // Actually just check it exists in a broader match
      const allFillers = history.match("filler-1");
      const hasFiller1 = allFillers.some((m) => m.command === "filler-1");
      expect(hasFiller1).toBe(true);
    });

    it("cleans up frequency map when entry is evicted", () => {
      // Add a command with multiple uses to build up frequency
      history.addCommand("old-command");
      history.addCommand("old-command");
      history.addCommand("old-command");

      // Fill to max (old-command is already in there, so fill 499 more unique ones)
      for (let i = 0; i < 499; i++) {
        history.addCommand(`filler-${i}`);
      }

      // old-command is now the oldest. Adding one more should evict it.
      history.addCommand("new-command");

      // old-command should be completely gone
      const matches = history.match("old-command");
      expect(matches).toHaveLength(0);
    });
  });

  describe("loaded state", () => {
    it("starts as not loaded", () => {
      expect(history.loaded).toBe(false);
    });

    it("can be marked as loaded", () => {
      history.markLoaded();
      expect(history.loaded).toBe(true);
    });
  });
});

// =============================================================================
// SuggestionEngine Tests
// =============================================================================
describe("SuggestionEngine - suggest()", () => {
  let history: HistoryProvider;

  beforeEach(() => {
    history = createHistoryProvider();
  });

  describe("basic behavior", () => {
    it("empty input returns empty array", () => {
      const results = suggest("", null, history);
      expect(results).toEqual([]);
    });

    it("whitespace-only input returns empty array", () => {
      const results = suggest("   ", null, history);
      expect(results).toEqual([]);
    });

    it("returns results from the static command index", () => {
      const results = suggest("git st", null, history);
      expect(results.length).toBeGreaterThan(0);
      // Should match "git status", "git stash", "git stash pop", "git stash list"
      const texts = results.map((r) => r.text);
      expect(texts).toContain("git status");
      expect(texts).toContain("git stash");
    });

    it("returns max 15 results", () => {
      // "git" prefix should match many commands in the index
      // Add a bunch of history entries too
      for (let i = 0; i < 20; i++) {
        history.addCommand(`git custom-cmd-${i}`);
      }
      const results = suggest("git", null, history);
      expect(results.length).toBeLessThanOrEqual(15);
    });
  });

  describe("scoring: history vs index", () => {
    it("history matches get higher base scores than index matches", () => {
      history.addCommand("git status");

      const results = suggest("git st", null, history);
      const fromHistory = results.find(
        (r) => r.text === "git status" && r.source === "history",
      );
      const fromIndex = results.find(
        (r) => r.source === "index" && r.text !== "git status",
      );

      // History base = 200 + freq + recency, Index base = 100 (+ possible bonuses)
      // With dedup, the same command keeps highest + 50, so we check the deduped entry
      if (fromHistory) {
        // If it came from history source, it should have score > 200
        expect(fromHistory.score).toBeGreaterThanOrEqual(200);
      }
      if (fromIndex) {
        // Pure index match without context/prefix bonus is 100 or 200
        expect(fromIndex.score).toBeLessThanOrEqual(350);
      }
    });

    it("frequency boost increases score (capped at 200)", () => {
      // Add same command many times to max out frequency
      for (let i = 0; i < 25; i++) {
        history.addCommand("git status");
      }

      const results = suggest("git st", null, history);
      const gitStatus = results.find((r) => r.text === "git status");
      expect(gitStatus).toBeDefined();
      // Score = 200 (base) + min(25*10, 200)=200 (freq) + 100 (recency, idx=0) + 50 (dedup) + possibly more
      // Should be well above 400
      expect(gitStatus!.score).toBeGreaterThan(400);
    });
  });

  describe("dedup: same command from history and index", () => {
    it("keeps highest score and adds +50 bonus", () => {
      history.addCommand("git status");

      const results = suggest("git st", null, history);
      // "git status" exists in both history and index
      // Should appear only once (deduped)
      const gitStatusEntries = results.filter((r) => r.text === "git status");
      expect(gitStatusEntries).toHaveLength(1);

      const entry = gitStatusEntries[0];
      // History score for freq=1, recencyIndex=0:
      // 200 + min(1*10,200)=10 + max(0, 100-0*2)=100 = 310
      // Index score for "git status" with prefix "git st": 100 + 100 (exact prefix) = 200
      // Dedup: keep 310 (history) + 50 = 360
      // Then description/badge should be preserved from the index source
      expect(entry.score).toBe(360);
      expect(entry.description).toBe("Show working tree status");
    });
  });

  describe("context relevance boost (+150)", () => {
    it("applies +150 for context-relevant commands", () => {
      const rustContext = makeContext({ languages: ["rust"] });

      // "cargo b" should match cargo build, cargo build --release
      const withContext = suggest("cargo b", rustContext, history);
      const withoutContext = suggest("cargo b", null, history);

      const cargoWithCtx = withContext.find((r) => r.text === "cargo build");
      const cargoNoCtx = withoutContext.find((r) => r.text === "cargo build");

      expect(cargoWithCtx).toBeDefined();
      expect(cargoNoCtx).toBeDefined();
      // With context should be 150 points higher
      expect(cargoWithCtx!.score - cargoNoCtx!.score).toBe(150);
    });

    it("git commands get boost when hasGit is true", () => {
      const gitContext = makeContext({ hasGit: true });

      const withContext = suggest("git st", gitContext, history);
      const withoutContext = suggest("git st", null, history);

      const statusWith = withContext.find((r) => r.text === "git status");
      const statusWithout = withoutContext.find((r) => r.text === "git status");

      expect(statusWith).toBeDefined();
      expect(statusWithout).toBeDefined();
      expect(statusWith!.score - statusWithout!.score).toBe(150);
    });

    it("npm commands get boost when packageManager is npm", () => {
      const npmContext = makeContext({ packageManager: "npm" });

      const withContext = suggest("npm i", npmContext, history);
      const withoutContext = suggest("npm i", null, history);

      const installWith = withContext.find((r) => r.text === "npm install");
      const installWithout = withoutContext.find((r) => r.text === "npm install");

      expect(installWith).toBeDefined();
      expect(installWithout).toBeDefined();
      expect(installWith!.score - installWithout!.score).toBe(150);
    });
  });

  describe("exact prefix bonus (+100)", () => {
    it("applies +100 when command starts with the input", () => {
      // "git status" starts with "git st"
      const results = suggest("git st", null, history);
      const gitStatus = results.find((r) => r.text === "git status");
      expect(gitStatus).toBeDefined();
      // Base 100 + prefix bonus 100 = 200
      expect(gitStatus!.score).toBe(200);
    });

    it("does not apply prefix bonus when command does not start with input", () => {
      // "git stash pop" starts with "git stash p" but not "git status"
      // Let's check "git stash" vs "git stash pop" with input "git stash p"
      const results = suggest("git stash p", null, history);
      const stashPop = results.find((r) => r.text === "git stash pop");
      const stash = results.find((r) => r.text === "git stash");

      expect(stashPop).toBeDefined();
      // "git stash pop" starts with "git stash p" -> gets prefix bonus
      expect(stashPop!.score).toBe(200); // 100 base + 100 prefix
      // "git stash" does NOT start with "git stash p" -> no prefix bonus
      expect(stash).toBeUndefined(); // it wouldn't match at all since lookupCommands filters by startsWith
    });
  });

  describe("length penalty (commands > 60 chars)", () => {
    it("applies penalty of -(len-60)*2 for long commands", () => {
      // Create a long history command
      const longCmd = "git commit -m \"this is a very long commit message for testing purposes here\"";
      expect(longCmd.length).toBeGreaterThan(60);
      history.addCommand(longCmd);

      const results = suggest("git commit", null, history);
      const longEntry = results.find((r) => r.text === longCmd);
      expect(longEntry).toBeDefined();

      // Base history score: 200 + freq(10) + recency(100) = 310
      // Length penalty: -(len - 60) * 2
      const expectedPenalty = (longCmd.length - 60) * 2;
      const expectedScore = 310 - expectedPenalty;
      expect(longEntry!.score).toBe(expectedScore);
    });

    it("no penalty for commands <= 60 chars", () => {
      history.addCommand("git status");

      const results = suggest("git st", null, history);
      const gitStatus = results.find((r) => r.text === "git status");
      expect(gitStatus).toBeDefined();

      // "git status" is 10 chars, well under 60
      // Dedup score: history(200+10+100) + 50 = 360
      // No length penalty
      expect(gitStatus!.score).toBe(360);
    });
  });

  describe("sorting", () => {
    it("results are sorted by score descending", () => {
      history.addCommand("git status");
      history.addCommand("git status");
      history.addCommand("git stash");

      const results = suggest("git st", null, history);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it("higher frequency history entries rank above lower frequency", () => {
      history.addCommand("git stash");
      history.addCommand("git status");
      history.addCommand("git status");
      history.addCommand("git status");
      history.addCommand("git status");
      history.addCommand("git status");

      const results = suggest("git st", null, history);
      const statusIdx = results.findIndex((r) => r.text === "git status");
      const stashIdx = results.findIndex((r) => r.text === "git stash");

      // "git status" has higher frequency, so it should rank higher
      expect(statusIdx).toBeLessThan(stashIdx);
    });
  });

  describe("single-token vs multi-token input", () => {
    it("single token uses prefix matching on first token", () => {
      // "gi" should match commands starting with "gi" (i.e., "git ...")
      const results = suggest("gi", null, history);
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.text.startsWith("git"))).toBe(true);
    });

    it("multi-token input uses exact prefix lookup", () => {
      // "git push" should match "git push", "git push -u origin", "git push --force-with-lease"
      const results = suggest("git push", null, history);
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.text.startsWith("git push"))).toBe(true);
    });
  });

  describe("mixed history and index results", () => {
    it("combines history and index results", () => {
      history.addCommand("cargo test --release");

      const results = suggest("cargo t", makeContext({ languages: ["rust"] }), history);
      // Should have the history entry and index entries like "cargo test"
      expect(results.length).toBeGreaterThan(0);
      const texts = results.map((r) => r.text);
      expect(texts).toContain("cargo test --release");
      expect(texts).toContain("cargo test");
    });

    it("preserves description and badge from index when deduped", () => {
      history.addCommand("cargo test");

      const results = suggest("cargo t", null, history);
      const cargoTest = results.find((r) => r.text === "cargo test");
      expect(cargoTest).toBeDefined();
      // Should pick up description from index source via dedup
      expect(cargoTest!.description).toBe("Run tests");
      expect(cargoTest!.badge).toBe("cargo");
    });
  });
});

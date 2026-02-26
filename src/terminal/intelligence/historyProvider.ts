import { readShellHistory, getSessionCommands } from "../../api/intelligence";

export interface HistoryMatch {
  command: string;
  frequency: number;
  recencyIndex: number; // lower = more recent
}

export interface HistoryProvider {
  loaded: boolean;
  markLoaded(): void;
  match(prefix: string): HistoryMatch[];
  addCommand(command: string): void;
}

const MAX_HISTORY = 500;

export function createHistoryProvider(): HistoryProvider {
  const frequencyMap = new Map<string, number>();
  const recencyList: string[] = []; // index 0 = most recent, no duplicates
  const recencySet = new Set<string>(); // O(1) existence checks, mirrors recencyList
  let loaded = false;

  function addToMaps(command: string): void {
    const trimmed = command.trim();
    if (!trimmed) return;

    frequencyMap.set(trimmed, (frequencyMap.get(trimmed) ?? 0) + 1);

    // Update recency — move to front if exists, or prepend
    if (recencySet.has(trimmed)) {
      // Already in list — splice out old position (list stays same length or shrinks by 1)
      const idx = recencyList.indexOf(trimmed);
      if (idx !== -1) recencyList.splice(idx, 1);
    }
    recencyList.unshift(trimmed);
    recencySet.add(trimmed);

    // Cap at MAX_HISTORY — pop oldest entry
    if (recencyList.length > MAX_HISTORY) {
      const removed = recencyList.pop()!;
      // Since recencyList has no duplicates, this entry is now gone
      recencySet.delete(removed);
      frequencyMap.delete(removed);
    }
  }

  return {
    get loaded() { return loaded; },
    markLoaded() { loaded = true; },

    match(prefix: string): HistoryMatch[] {
      const trimmedPrefix = prefix.trim();
      if (!trimmedPrefix) return [];

      const results: HistoryMatch[] = [];

      for (let i = 0; i < recencyList.length; i++) {
        const cmd = recencyList[i];
        if (cmd.startsWith(trimmedPrefix)) {
          results.push({
            command: cmd,
            frequency: frequencyMap.get(cmd) ?? 1,
            recencyIndex: i,
          });
        }
      }

      return results;
    },

    addCommand(command: string): void {
      addToMaps(command);
    },
  };
}

/** Load history from shell history file + session commands.
 *  Guarded: calling multiple times is safe — only the first call loads. */
export async function loadHistory(
  provider: HistoryProvider,
  sessionId: string,
  shell: string,
): Promise<void> {
  // Prevent duplicate/concurrent loads — only the first call proceeds
  if (provider.loaded) return;

  try {
    // Load shell history file (most recent 500)
    const shellHistory = await readShellHistory(shell, MAX_HISTORY);
    // Add oldest first so most recent ends up at front
    for (let i = shellHistory.length - 1; i >= 0; i--) {
      provider.addCommand(shellHistory[i]);
    }
  } catch {
    // Shell history not available — not critical
  }

  try {
    // Load session commands from execution_log DB
    const sessionCommands = await getSessionCommands(sessionId, MAX_HISTORY);
    // Session commands are more recent, add last
    for (let i = sessionCommands.length - 1; i >= 0; i--) {
      provider.addCommand(sessionCommands[i]);
    }
  } catch {
    // Session history not available — not critical
  }

  provider.markLoaded();
}

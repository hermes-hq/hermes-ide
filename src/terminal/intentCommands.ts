// ─── Intent Commands ─────────────────────────────────────────────────
// Colon-prefixed shortcuts resolved before the shell sees them.

export type IntentResult =
  | { resolved: true; command: string; description: string }
  | { resolved: false };

interface IntentContext {
  cwd: string;
}

export function resolveIntent(input: string, _ctx: IntentContext): IntentResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith(":")) return { resolved: false };

  const intent = trimmed.slice(1).trim().toLowerCase();

  if (intent === "run tests" || intent === "test") {
    return { resolved: true, command: detectTestRunner(), description: "Run tests" };
  }

  if (intent === "what changed" || intent === "changed" || intent === "diff") {
    return { resolved: true, command: "git diff --stat", description: "Show changed files" };
  }

  if (intent === "status" || intent === "st") {
    return { resolved: true, command: "git status", description: "Git status" };
  }

  if (intent === "clean up" || intent === "cleanup") {
    return {
      resolved: true,
      command: "git branch --merged | grep -vE 'main|master|\\*'",
      description: "Show merged branches",
    };
  }

  if (intent === "log") {
    return { resolved: true, command: "git log --oneline -15", description: "Recent commits" };
  }

  return { resolved: false };
}

function detectTestRunner(): string {
  // Heuristic default — contextAnalyzer will refine per-project
  return "npm test";
}

/** Intent suggestions for the suggestion engine when input starts with `:` */
export function getIntentSuggestions(input: string): { text: string; description: string }[] {
  if (!input.startsWith(":")) return [];

  const partial = input.slice(1).trim().toLowerCase();

  const intents = [
    { text: ":run tests", description: "Detect & run test suite" },
    { text: ":what changed", description: "git diff --stat" },
    { text: ":status", description: "git status" },
    { text: ":clean up", description: "Show merged branches" },
    { text: ":log", description: "git log --oneline -15" },
  ];

  if (!partial) return intents;

  return intents.filter((i) => {
    const name = i.text.slice(1).toLowerCase();
    return name.startsWith(partial) || name.includes(partial);
  });
}

export interface StyleDefinition {
  id: string;
  label: string;
  description?: string;
  /** 5 instruction strings, indexed 0-4 for levels 1-5 */
  levels: [string, string, string, string, string];
  builtIn: boolean;
}

export interface SelectedStyle {
  id: string;
  level: number; // 1–5
}

export const BUILT_IN_STYLES: StyleDefinition[] = [
  {
    id: "concise",
    label: "Concise",
    description: "Brief, to-the-point responses",
    levels: [
      "Keep responses fairly brief where possible.",
      "Be somewhat concise. Trim unnecessary detail.",
      "Be concise. Get to the point quickly.",
      "Be very concise. Minimize prose, maximize signal.",
      "Be extremely concise. Absolute minimum words needed.",
    ],
    builtIn: true,
  },
  {
    id: "detailed",
    label: "Detailed",
    description: "Thorough, comprehensive explanations",
    levels: [
      "Include a bit of extra context where helpful.",
      "Provide moderately detailed explanations.",
      "Be detailed and thorough in explanations.",
      "Be very detailed. Cover edge cases and nuances.",
      "Be exhaustively detailed. Leave nothing unexplained.",
    ],
    builtIn: true,
  },
  {
    id: "code-heavy",
    label: "Code-Heavy",
    description: "Prioritize code examples over prose",
    levels: [
      "Include code examples where helpful.",
      "Lean towards showing code over explaining in prose.",
      "Prioritize code examples. Show don't tell.",
      "Heavily prioritize code. Minimal prose between code blocks.",
      "Almost entirely code. Only essential commentary.",
    ],
    builtIn: true,
  },
  {
    id: "step-by-step",
    label: "Step-by-Step",
    description: "Numbered breakdowns and sequences",
    levels: [
      "Use numbered steps for complex sequences.",
      "Break down the approach into clear steps.",
      "Use step-by-step numbered breakdowns throughout.",
      "Structure everything as detailed numbered steps with sub-steps.",
      "Rigorous step-by-step format. Every action is a numbered step with rationale.",
    ],
    builtIn: true,
  },
  {
    id: "diff-format",
    label: "Diff Format",
    description: "Show changes as before/after diffs",
    levels: [
      "Show diffs for the most important changes.",
      "Use before/after format for key changes.",
      "Show all changes as diffs. Before/after for every modification.",
      "Always use diff format. Show complete before/after for every file touched.",
      "Strict diff-only format. Every change must be a clearly marked diff block.",
    ],
    builtIn: true,
  },
  {
    id: "formal",
    label: "Formal",
    description: "Professional, technical tone",
    levels: [
      "Use a mostly professional tone.",
      "Maintain a professional and clear tone.",
      "Use a formal, professional tone throughout.",
      "Strictly professional tone. Technical and precise language.",
      "Highly formal academic/technical tone. No colloquialisms.",
    ],
    builtIn: true,
  },
  {
    id: "casual",
    label: "Casual",
    description: "Conversational, friendly tone",
    levels: [
      "Use a slightly relaxed tone.",
      "Keep a friendly, approachable tone.",
      "Use a casual, conversational tone.",
      "Very casual and friendly. Like chatting with a colleague.",
      "Ultra-casual. Direct, informal, peer-to-peer style.",
    ],
    builtIn: true,
  },
  {
    id: "beginner",
    label: "Beginner-Friendly",
    description: "Simple language, more context",
    levels: [
      "Define uncommon terms when they appear.",
      "Explain technical concepts when introduced.",
      "Assume limited prior knowledge. Explain concepts clearly.",
      "Very beginner-friendly. Define all terms. Use analogies.",
      "Assume no prior knowledge. Explain everything from first principles.",
    ],
    builtIn: true,
  },
  {
    id: "expert",
    label: "Expert-Level",
    description: "Dense, assumes deep knowledge",
    levels: [
      "Assume basic familiarity with the domain.",
      "Assume solid working knowledge. Skip obvious basics.",
      "Assume expert-level knowledge. Be dense and technical.",
      "Assume deep expertise. Use advanced terminology freely.",
      "Maximum information density. Assume complete domain mastery.",
    ],
    builtIn: true,
  },
  {
    id: "visual",
    label: "Visual",
    description: "Tables, diagrams, rich formatting",
    levels: [
      "Use formatting like tables or lists where helpful.",
      "Include tables and structured formatting for clarity.",
      "Use tables, lists, and visual formatting throughout.",
      "Heavy use of tables, diagrams, and structured visual layouts.",
      "Maximize visual structure. Tables, diagrams, ASCII art, formatted comparisons.",
    ],
    builtIn: true,
  },
  {
    id: "opinionated",
    label: "Opinionated",
    description: "Strong, clear recommendations",
    levels: [
      "Gently suggest a preferred approach when relevant.",
      "Offer recommendations with your reasoning.",
      "Be opinionated. Recommend specific approaches clearly.",
      "Strongly opinionated. Make clear recommendations with conviction.",
      "Decisively opinionated. State the best approach. Argue against alternatives.",
    ],
    builtIn: true,
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "Present multiple options with tradeoffs",
    levels: [
      "Mention alternatives when there are significant tradeoffs.",
      "Present the main alternatives with brief tradeoff notes.",
      "Present multiple options with clear tradeoff analysis.",
      "Thoroughly compare alternatives. Detailed pros/cons for each.",
      "Exhaustive comparison of all viable approaches with full tradeoff matrices.",
    ],
    builtIn: true,
  },
  {
    id: "actionable",
    label: "Actionable",
    description: "Focus on concrete next steps",
    levels: [
      "End with a suggested next step.",
      "Include actionable takeaways in your response.",
      "Focus on actionable next steps. What to do, not just what to know.",
      "Strongly action-oriented. Every section ends with concrete action items.",
      "Purely action-focused. Skip theory. Only deliverable steps and commands.",
    ],
    builtIn: true,
  },
  {
    id: "socratic",
    label: "Socratic",
    description: "Guide with questions, teach by inquiry",
    levels: [
      "Occasionally ask clarifying questions.",
      "Ask guiding questions to help explore the problem.",
      "Use a Socratic approach. Guide with questions before giving answers.",
      "Heavily Socratic. Lead with questions. Let the user discover the answer.",
      "Purely Socratic. Only ask questions. Never give direct answers.",
    ],
    builtIn: true,
  },
];

/**
 * Merge selected styles with their intensity levels into a compiled style instruction string.
 * Deterministic: same selections always produce the same output.
 */
export function mergeStyles(selections: SelectedStyle[], allStyles: StyleDefinition[]): string {
  if (selections.length === 0) return "";

  const instructions: string[] = [];
  for (const sel of selections) {
    const def = allStyles.find((s) => s.id === sel.id);
    if (!def) continue;
    const raw = sel.level - 1;
    const idx = Number.isFinite(raw) ? Math.max(0, Math.min(4, raw)) : 0;
    instructions.push(def.levels[idx]);
  }

  return instructions.join(" ");
}

/**
 * Validate a custom style definition.
 */
export function validateCustomStyle(
  style: Omit<StyleDefinition, "id" | "builtIn">,
  existingStyles: StyleDefinition[],
): { valid: boolean; error?: string } {
  if (!style.label.trim()) {
    return { valid: false, error: "Label is required" };
  }
  if (style.levels.some((l) => !l.trim())) {
    return { valid: false, error: "All 5 level instructions are required" };
  }
  const duplicate = existingStyles.find(
    (s) => s.label.trim().toLowerCase() === style.label.trim().toLowerCase(),
  );
  if (duplicate) {
    return { valid: false, error: `A style with label "${duplicate.label}" already exists` };
  }
  return { valid: true };
}

/**
 * Permission rule helpers.  Spec: §2 (M5) + §7.9.
 *
 * Rules live in `~/.claude/settings.json` (user scope) and the project
 * `.claude/settings.json` (project scope).  Hermes writes there directly
 * so the rule applies in standalone Claude Code too.
 */

export type RuleKind = "allow" | "deny";
export type RuleSource = "user" | "project";

export interface PermissionRule {
  pattern: string;
  source: RuleSource;
  kind: RuleKind;
}

export type Verdict =
  | { verdict: "allow"; source: RuleSource; pattern: string }
  | { verdict: "deny"; source: RuleSource; pattern: string }
  | { verdict: "no-match" };

export function classifyRule(rule: PermissionRule): RuleKind {
  return rule.kind;
}

/** Live verdict for a tool input.  Loose match: rule pattern's prefix
 *  before `(` is the tool name; the part inside parens is matched as a
 *  glob (just `:*` for now — substring).  Project deny shadows user
 *  allow per Claude's documented precedence. */
export function testPattern(input: string, rules: readonly PermissionRule[]): Verdict {
  if (!input.trim()) return { verdict: "no-match" };

  const matches = rules.filter((r) => ruleMatches(r.pattern, input));
  if (matches.length === 0) return { verdict: "no-match" };

  // Project deny wins over everything; then user deny; then any allow.
  const projectDeny = matches.find((r) => r.kind === "deny" && r.source === "project");
  if (projectDeny) return { verdict: "deny", source: "project", pattern: projectDeny.pattern };
  const userDeny = matches.find((r) => r.kind === "deny" && r.source === "user");
  if (userDeny) return { verdict: "deny", source: "user", pattern: userDeny.pattern };
  const allow = matches.find((r) => r.kind === "allow");
  if (allow) return { verdict: "allow", source: allow.source, pattern: allow.pattern };
  return { verdict: "no-match" };
}

function ruleMatches(pattern: string, input: string): boolean {
  const pParen = pattern.indexOf("(");
  const iParen = input.indexOf("(");
  if (pParen === -1 || iParen === -1) return pattern === input;
  const pTool = pattern.slice(0, pParen);
  const iTool = input.slice(0, iParen);
  if (pTool !== iTool) return false;
  const pBody = pattern.slice(pParen + 1, pattern.length - 1);
  const iBody = input.slice(iParen + 1, input.length - 1);
  // Trailing `:*` matches anything starting with the prefix.
  if (pBody.endsWith(":*")) {
    return iBody.startsWith(pBody.slice(0, -2));
  }
  return pBody === iBody;
}

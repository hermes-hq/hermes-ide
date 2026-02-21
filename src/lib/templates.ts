import type { SelectedStyle } from "./styles";

export type TemplateCategory =
  | "debugging"
  | "refactoring"
  | "performance"
  | "security"
  | "testing"
  | "architecture"
  | "documentation"
  | "git-review";

export interface PromptTemplate {
  id: string;
  name: string;
  category: TemplateCategory;
  fields: Partial<import("./compilePrompt").ComposerFields>;
  recommendedRoles: string[];
  recommendedStyles: SelectedStyle[];
  builtIn: boolean;
}

export const TEMPLATE_CATEGORIES: Record<TemplateCategory, { label: string; icon: string }> = {
  debugging:     { label: "Debugging",         icon: "~" },
  refactoring:   { label: "Refactoring",       icon: ">" },
  performance:   { label: "Performance",       icon: "*" },
  security:      { label: "Security",          icon: "#" },
  testing:       { label: "Testing",           icon: "?" },
  architecture:  { label: "Architecture",      icon: "^" },
  documentation: { label: "Documentation",     icon: "=" },
  "git-review":  { label: "Git & Code Review", icon: "@" },
};

export const BUILT_IN_TEMPLATES: PromptTemplate[] = [
  // ── Debugging (5) ──
  {
    id: "debug-root-cause",
    name: "Root Cause Analysis",
    category: "debugging",
    recommendedRoles: ["debugger", "backend-eng"],
    recommendedStyles: [{ id: "step-by-step", level: 3 }, { id: "diff-format", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Identify the root cause before proposing fixes. Consider edge cases and race conditions.",
      style: "Start with root-cause analysis. Then propose a minimal fix. Show the fix as a diff.",
    },
  },
  {
    id: "debug-error-trace",
    name: "Error Trace Analysis",
    category: "debugging",
    recommendedRoles: ["debugger"],
    recommendedStyles: [{ id: "step-by-step", level: 4 }, { id: "detailed", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Trace the error from origin to manifestation. Identify all contributing factors.",
      style: "Walk through the stack trace step by step. Highlight the key failure point.",
    },
  },
  {
    id: "debug-race-condition",
    name: "Race Condition Hunt",
    category: "debugging",
    recommendedRoles: ["debugger", "concurrency-specialist"],
    recommendedStyles: [{ id: "visual", level: 3 }, { id: "step-by-step", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Identify shared mutable state, timing dependencies, and missing synchronization.",
      style: "Diagram the sequence of events. Show the problematic interleaving and the fix.",
    },
  },
  {
    id: "debug-memory-leak",
    name: "Memory Leak Investigation",
    category: "debugging",
    recommendedRoles: ["debugger", "performance-specialist"],
    recommendedStyles: [{ id: "step-by-step", level: 3 }, { id: "visual", level: 2 }],
    builtIn: true,
    fields: {
      constraints: "Look for retained references, unclosed resources, and growing collections.",
      style: "Identify the retention chain. Show before/after memory profiles if possible.",
    },
  },
  {
    id: "debug-flaky-test",
    name: "Flaky Test Diagnosis",
    category: "debugging",
    recommendedRoles: ["debugger", "test-engineer"],
    recommendedStyles: [{ id: "actionable", level: 3 }, { id: "code-heavy", level: 2 }],
    builtIn: true,
    fields: {
      constraints: "Consider timing, shared state, external dependencies, and test isolation.",
      style: "Identify non-deterministic factors. Propose deterministic alternatives.",
    },
  },

  // ── Refactoring (5) ──
  {
    id: "refactor-extract",
    name: "Extract & Simplify",
    category: "refactoring",
    recommendedRoles: ["refactoring-specialist"],
    recommendedStyles: [{ id: "diff-format", level: 4 }, { id: "code-heavy", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Keep the existing public API stable. No new dependencies. Must pass all existing tests.",
      style: "Show before/after code. Explain why each extraction improves the codebase.",
    },
  },
  {
    id: "refactor-patterns",
    name: "Apply Design Patterns",
    category: "refactoring",
    recommendedRoles: ["refactoring-specialist", "architect"],
    recommendedStyles: [{ id: "diff-format", level: 3 }, { id: "balanced", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Only apply patterns that reduce complexity. Avoid over-engineering.",
      style: "Name the pattern. Show before/after. Explain the tradeoffs.",
    },
  },
  {
    id: "refactor-naming",
    name: "Naming & Readability",
    category: "refactoring",
    recommendedRoles: ["refactoring-specialist"],
    recommendedStyles: [{ id: "visual", level: 3 }, { id: "diff-format", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Focus on naming, clarity, and self-documenting code. No behavioral changes.",
      style: "Show each rename with rationale. Group by category (variables, functions, types).",
    },
  },
  {
    id: "refactor-dedup",
    name: "Remove Duplication",
    category: "refactoring",
    recommendedRoles: ["refactoring-specialist"],
    recommendedStyles: [{ id: "diff-format", level: 4 }, { id: "code-heavy", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Eliminate duplication without premature abstraction. Keep it simple.",
      style: "Show duplicated code side by side, then the unified version.",
    },
  },
  {
    id: "refactor-types",
    name: "Strengthen Types",
    category: "refactoring",
    recommendedRoles: ["refactoring-specialist", "typescript-specialist"],
    recommendedStyles: [{ id: "code-heavy", level: 4 }, { id: "diff-format", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Replace any/unknown with precise types. Use discriminated unions where appropriate.",
      style: "Show type before/after. Explain what new type errors this would catch.",
    },
  },

  // ── Performance (5) ──
  {
    id: "perf-profile",
    name: "Performance Profiling",
    category: "performance",
    recommendedRoles: ["performance-specialist"],
    recommendedStyles: [{ id: "visual", level: 3 }, { id: "actionable", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Measure before optimizing. Focus on the hottest code paths.",
      style: "Show profiling data interpretation. Rank optimizations by expected impact.",
    },
  },
  {
    id: "perf-database",
    name: "Query Optimization",
    category: "performance",
    recommendedRoles: ["performance-specialist", "backend-eng"],
    recommendedStyles: [{ id: "code-heavy", level: 3 }, { id: "diff-format", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Analyze query plans. Consider indexing, N+1 queries, and connection pooling.",
      style: "Show the slow query, explain the plan, and show the optimized version.",
    },
  },
  {
    id: "perf-bundle",
    name: "Bundle Size Reduction",
    category: "performance",
    recommendedRoles: ["performance-specialist", "frontend-eng"],
    recommendedStyles: [{ id: "visual", level: 3 }, { id: "actionable", level: 4 }],
    builtIn: true,
    fields: {
      constraints: "Identify large dependencies, unused code, and code splitting opportunities.",
      style: "Show bundle analysis results. Rank recommendations by size impact.",
    },
  },
  {
    id: "perf-render",
    name: "Render Performance",
    category: "performance",
    recommendedRoles: ["performance-specialist", "frontend-eng"],
    recommendedStyles: [{ id: "code-heavy", level: 3 }, { id: "diff-format", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Focus on unnecessary re-renders, expensive computations, and DOM operations.",
      style: "Identify render bottlenecks. Show optimized component structure.",
    },
  },
  {
    id: "perf-algorithm",
    name: "Algorithm Optimization",
    category: "performance",
    recommendedRoles: ["performance-specialist"],
    recommendedStyles: [{ id: "code-heavy", level: 3 }, { id: "visual", level: 2 }],
    builtIn: true,
    fields: {
      constraints: "Analyze time and space complexity. Consider practical vs theoretical improvements.",
      style: "Show complexity analysis. Compare before/after with Big-O notation.",
    },
  },

  // ── Security (4) ──
  {
    id: "sec-audit",
    name: "Security Audit",
    category: "security",
    recommendedRoles: ["security-auditor"],
    recommendedStyles: [{ id: "formal", level: 3 }, { id: "detailed", level: 4 }],
    builtIn: true,
    fields: {
      constraints: "Check OWASP Top 10, injection vectors, authentication, and authorization flaws.",
      style: "Use severity levels (critical, high, medium, low). Show proof-of-concept for each finding.",
    },
  },
  {
    id: "sec-auth",
    name: "Auth Flow Review",
    category: "security",
    recommendedRoles: ["security-auditor", "backend-eng"],
    recommendedStyles: [{ id: "visual", level: 3 }, { id: "step-by-step", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Review token handling, session management, password policies, and privilege escalation.",
      style: "Map the auth flow. Identify each trust boundary and potential bypass.",
    },
  },
  {
    id: "sec-input",
    name: "Input Validation Review",
    category: "security",
    recommendedRoles: ["security-auditor"],
    recommendedStyles: [{ id: "visual", level: 3 }, { id: "actionable", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Check all user inputs for injection, XSS, path traversal, and type confusion.",
      style: "List each input vector with its validation status and recommended fix.",
    },
  },
  {
    id: "sec-deps",
    name: "Dependency Audit",
    category: "security",
    recommendedRoles: ["security-auditor"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "actionable", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Check for known CVEs, outdated packages, and supply chain risks.",
      style: "List vulnerable dependencies with severity, CVE ID, and upgrade path.",
    },
  },

  // ── Testing (4) ──
  {
    id: "test-unit",
    name: "Unit Test Generation",
    category: "testing",
    recommendedRoles: ["test-engineer"],
    recommendedStyles: [{ id: "code-heavy", level: 4 }, { id: "step-by-step", level: 2 }],
    builtIn: true,
    fields: {
      constraints: "Cover happy path, edge cases, and error conditions. Use AAA pattern.",
      style: "Group tests by behavior. Use descriptive test names. Show expected vs actual.",
    },
  },
  {
    id: "test-integration",
    name: "Integration Test Plan",
    category: "testing",
    recommendedRoles: ["test-engineer", "architect"],
    recommendedStyles: [{ id: "step-by-step", level: 4 }, { id: "visual", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Test component interactions, API contracts, and data flow between modules.",
      style: "Structure as test scenarios with setup, action, and verification steps.",
    },
  },
  {
    id: "test-coverage",
    name: "Coverage Gap Analysis",
    category: "testing",
    recommendedRoles: ["test-engineer"],
    recommendedStyles: [{ id: "visual", level: 3 }, { id: "actionable", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Identify untested code paths, missing edge cases, and weak assertions.",
      style: "Rank gaps by risk. Show the specific untested scenarios.",
    },
  },
  {
    id: "test-refactor",
    name: "Test Refactoring",
    category: "testing",
    recommendedRoles: ["test-engineer", "refactoring-specialist"],
    recommendedStyles: [{ id: "diff-format", level: 4 }, { id: "code-heavy", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Improve test clarity and maintainability without changing coverage.",
      style: "Show before/after for each test improvement. Explain the benefit.",
    },
  },

  // ── Architecture (4) ──
  {
    id: "arch-review",
    name: "Architecture Review",
    category: "architecture",
    recommendedRoles: ["architect"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "opinionated", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Evaluate coupling, cohesion, scalability, and maintainability.",
      style: "Use diagrams where helpful. Identify architectural smells and propose alternatives.",
    },
  },
  {
    id: "arch-migration",
    name: "Migration Strategy",
    category: "architecture",
    recommendedRoles: ["architect", "backend-eng"],
    recommendedStyles: [{ id: "step-by-step", level: 4 }, { id: "visual", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Plan for zero-downtime migration. Include rollback strategy.",
      style: "Break into phases. Show the migration path with risk assessment for each phase.",
    },
  },
  {
    id: "arch-api-design",
    name: "API Design Review",
    category: "architecture",
    recommendedRoles: ["architect", "api-designer"],
    recommendedStyles: [{ id: "visual", level: 3 }, { id: "opinionated", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Evaluate consistency, versioning, error handling, and backwards compatibility.",
      style: "Review each endpoint. Show recommended changes with rationale.",
    },
  },
  {
    id: "arch-decompose",
    name: "Service Decomposition",
    category: "architecture",
    recommendedRoles: ["architect"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "balanced", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Identify bounded contexts and service boundaries. Minimize cross-service calls.",
      style: "Map the domain. Show proposed service boundaries with communication patterns.",
    },
  },

  // ── Documentation (4) ──
  {
    id: "doc-api",
    name: "API Documentation",
    category: "documentation",
    recommendedRoles: ["technical-writer"],
    recommendedStyles: [{ id: "visual", level: 3 }, { id: "code-heavy", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Document all endpoints, parameters, response types, and error codes.",
      style: "Use consistent format with examples for each endpoint. Include curl examples.",
    },
  },
  {
    id: "doc-readme",
    name: "README Generation",
    category: "documentation",
    recommendedRoles: ["technical-writer"],
    recommendedStyles: [{ id: "beginner", level: 3 }, { id: "visual", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Include setup, usage, configuration, and contributing sections.",
      style: "Clear and welcoming. Use badges, code blocks, and structured headings.",
    },
  },
  {
    id: "doc-architecture",
    name: "Architecture Doc",
    category: "documentation",
    recommendedRoles: ["technical-writer", "architect"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "formal", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Document key decisions, tradeoffs, and system boundaries.",
      style: "Use diagrams. Include decision records (ADRs) for major choices.",
    },
  },
  {
    id: "doc-changelog",
    name: "Changelog Entry",
    category: "documentation",
    recommendedRoles: ["technical-writer"],
    recommendedStyles: [{ id: "concise", level: 4 }, { id: "actionable", level: 2 }],
    builtIn: true,
    fields: {
      constraints: "Follow Keep a Changelog format. Categorize as Added, Changed, Fixed, Removed.",
      style: "Concise entries. Link to PRs/issues where applicable.",
    },
  },

  // ── Git & Code Review (4) ──
  {
    id: "git-review",
    name: "Code Review",
    category: "git-review",
    recommendedRoles: ["code-reviewer"],
    recommendedStyles: [{ id: "concise", level: 3 }, { id: "formal", level: 2 }],
    builtIn: true,
    fields: {
      constraints: "Review for correctness, performance, security, and maintainability.",
      style: "Be concise. Use severity levels (critical, warning, suggestion). Show line references.",
    },
  },
  {
    id: "git-commit-msg",
    name: "Commit Message",
    category: "git-review",
    recommendedRoles: ["code-reviewer"],
    recommendedStyles: [{ id: "concise", level: 5 }, { id: "formal", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Follow conventional commits format. Separate subject from body.",
      style: "Subject line under 50 chars. Body explains why, not what.",
    },
  },
  {
    id: "git-pr-review",
    name: "PR Review",
    category: "git-review",
    recommendedRoles: ["code-reviewer", "architect"],
    recommendedStyles: [{ id: "step-by-step", level: 3 }, { id: "opinionated", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Review overall design, test coverage, and potential regressions.",
      style: "Start with summary. Then detail findings by file. End with approval/changes-requested.",
    },
  },
  {
    id: "git-bisect",
    name: "Git Bisect Guide",
    category: "git-review",
    recommendedRoles: ["debugger", "code-reviewer"],
    recommendedStyles: [{ id: "step-by-step", level: 5 }, { id: "code-heavy", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Guide through bisecting to find the commit that introduced the issue.",
      style: "Step-by-step git commands. Show how to write a test script for automated bisect.",
    },
  },

  // ── Migrated v1 templates ──
  {
    id: "bug-fix",
    name: "Bug Fix",
    category: "debugging",
    recommendedRoles: ["debugger"],
    recommendedStyles: [{ id: "diff-format", level: 3 }, { id: "step-by-step", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Focus on minimal, targeted fixes. Avoid unrelated changes.",
      style: "Start with root-cause analysis. Then propose a minimal fix. Show the fix as a diff.",
    },
  },
  {
    id: "explain",
    name: "Explain",
    category: "documentation",
    recommendedRoles: ["technical-writer"],
    recommendedStyles: [{ id: "step-by-step", level: 3 }, { id: "beginner", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Explain at the appropriate level of abstraction for the audience.",
      style: "Use step-by-step explanations with examples. Start with a high-level overview, then dive into details.",
    },
  },
];

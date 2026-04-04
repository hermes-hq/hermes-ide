import type { SelectedStyle } from "./styles";

export type TemplateCategory =
  | "debugging"
  | "refactoring"
  | "performance"
  | "security"
  | "testing"
  | "architecture"
  | "documentation"
  | "git-review"
  | "product"
  | "planning"
  | "design"
  | "devops"
  | "data"
  | "ai-ml"
  | "incident"
  | "business"
  | "monetization"
  | "legal";

export interface PromptTemplate {
  id: string;
  name: string;
  description?: string;
  category: TemplateCategory;
  fields: Partial<import("./compilePrompt").ComposerFields>;
  recommendedRoles: string[];
  recommendedStyles: SelectedStyle[];
  builtIn: boolean;
  group?: string;
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
  product:       { label: "Product Management", icon: "%" },
  planning:      { label: "Planning & Strategy", icon: "&" },
  design:        { label: "UX & Design",        icon: "+" },
  devops:        { label: "DevOps & Infra",    icon: "!" },
  data:          { label: "Data & Analytics",  icon: ":" },
  "ai-ml":       { label: "AI & ML",           icon: "$" },
  incident:      { label: "Incident Response", icon: ";" },
  business:      { label: "Business & Growth", icon: "'" },
  monetization:  { label: "Monetization",     icon: "¢" },
  legal:         { label: "Legal & Compliance", icon: "§" },
};

export const BUILT_IN_TEMPLATES: PromptTemplate[] = [
  // ── Debugging (5) ──
  {
    id: "debug-root-cause",
    name: "Root Cause Analysis",
    description: "Systematically trace a bug to its origin before proposing a minimal fix.",
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
    description: "Walk through a stack trace step by step to pinpoint the failure.",
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
    description: "Find shared mutable state, timing bugs, and missing synchronization.",
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
    description: "Track down retained references, unclosed resources, and growing collections.",
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
    description: "Identify non-deterministic factors causing intermittent test failures.",
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
    description: "Break down complex code into smaller, focused functions and modules.",
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
    description: "Introduce well-known design patterns to reduce complexity.",
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
    description: "Improve variable, function, and type names for self-documenting code.",
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
    description: "Find and unify duplicated code without premature abstraction.",
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
    description: "Replace any/unknown with precise types and discriminated unions.",
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
    description: "Measure hotspots and rank optimizations by expected impact.",
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
    description: "Analyze query plans, fix N+1 issues, and optimize indexing.",
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
    description: "Find large deps, unused code, and code-splitting opportunities.",
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
    description: "Fix unnecessary re-renders, expensive computations, and DOM thrashing.",
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
    description: "Analyze time/space complexity and find more efficient approaches.",
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
    description: "Check OWASP Top 10 vulnerabilities with proof-of-concept for each.",
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
    description: "Map trust boundaries in your auth flow and find bypass risks.",
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
    description: "Audit all user inputs for injection, XSS, and path traversal.",
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
    description: "Scan for known CVEs, outdated packages, and supply chain risks.",
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
    description: "Generate tests covering happy path, edge cases, and error conditions.",
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
    description: "Plan tests for component interactions, API contracts, and data flow.",
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
    description: "Find untested code paths, missing edge cases, and weak assertions.",
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
    description: "Clean up tests for clarity and maintainability without losing coverage.",
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
    description: "Evaluate coupling, cohesion, scalability, and architectural smells.",
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
    description: "Plan a zero-downtime migration with phased rollout and rollback.",
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
    description: "Review API consistency, versioning, errors, and backwards compat.",
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
    description: "Identify bounded contexts and propose service boundaries.",
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
    description: "Document endpoints, params, responses, and error codes with examples.",
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
    description: "Create a welcoming README with setup, usage, and contributing guide.",
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
    description: "Document system design decisions, tradeoffs, and boundaries.",
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
    description: "Write a changelog in Keep a Changelog format (Added/Changed/Fixed).",
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
    description: "Review code for correctness, performance, security, and style.",
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
    description: "Draft a conventional commit message explaining the why, not the what.",
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
    description: "Review a pull request for design, coverage, and regressions.",
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
    description: "Walk through git bisect to find the commit that introduced a bug.",
    category: "git-review",
    recommendedRoles: ["debugger", "code-reviewer"],
    recommendedStyles: [{ id: "step-by-step", level: 5 }, { id: "code-heavy", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Guide through bisecting to find the commit that introduced the issue.",
      style: "Step-by-step git commands. Show how to write a test script for automated bisect.",
    },
  },

  // ── Product Management (4) ──
  {
    id: "product-prd",
    name: "PRD Writing",
    description: "Write a PRD with problem, goals, personas, and success metrics.",
    category: "product",
    recommendedRoles: ["product-manager"],
    recommendedStyles: [{ id: "detailed", level: 4 }, { id: "visual", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Include problem statement, goals, user personas, requirements, success metrics, and out-of-scope items.",
      style: "Use structured sections with clear headings. Include acceptance criteria for each requirement.",
    },
  },
  {
    id: "product-user-stories",
    name: "User Story Generation",
    description: "Generate user stories with acceptance criteria, grouped by epic.",
    category: "product",
    recommendedRoles: ["product-manager"],
    recommendedStyles: [{ id: "actionable", level: 4 }, { id: "visual", level: 2 }],
    builtIn: true,
    fields: {
      constraints: "Follow the 'As a [user], I want [goal], so that [benefit]' format. Include acceptance criteria and edge cases.",
      style: "Group stories by epic or theme. Include story points estimation guidance and dependencies.",
    },
  },
  {
    id: "product-prioritization",
    name: "Feature Prioritization",
    description: "Score and rank features using RICE, ICE, or MoSCoW frameworks.",
    category: "product",
    recommendedRoles: ["product-manager", "data-analyst"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "balanced", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Use a prioritization framework (RICE, ICE, or MoSCoW). Consider impact, effort, confidence, and reach.",
      style: "Present as a scored table. Justify each score. Show the final ranked priority list.",
    },
  },
  {
    id: "product-competitive",
    name: "Competitive Analysis",
    description: "Compare competitors on features, pricing, and strategic gaps.",
    category: "product",
    recommendedRoles: ["product-manager"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "detailed", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Compare features, pricing, strengths, and weaknesses across competitors. Identify gaps and opportunities.",
      style: "Use comparison tables. Highlight differentiators. Conclude with strategic recommendations.",
    },
  },

  // ── Planning & Strategy (4) ──
  {
    id: "planning-sprint",
    name: "Sprint Planning",
    description: "Define sprint goal, backlog, task breakdown, and capacity check.",
    category: "planning",
    recommendedRoles: ["project-manager", "product-manager"],
    recommendedStyles: [{ id: "actionable", level: 4 }, { id: "visual", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Define sprint goal, capacity, selected backlog items, and task breakdown. Flag risks and dependencies.",
      style: "Structure as sprint goal, then itemized task list with estimates and assignees. Include a capacity check.",
    },
  },
  {
    id: "planning-roadmap",
    name: "Roadmap Planning",
    description: "Build a now/next/later roadmap aligned to strategic goals.",
    category: "planning",
    recommendedRoles: ["product-manager", "architect"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "opinionated", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Organize by time horizons (now, next, later). Align features to strategic goals. Identify dependencies.",
      style: "Use a timeline or swimlane format. Show milestones and key deliverables. Mark dependencies clearly.",
    },
  },
  {
    id: "planning-spike",
    name: "Technical Spike",
    description: "Time-boxed investigation with options, pros/cons, and a recommendation.",
    category: "planning",
    recommendedRoles: ["architect", "project-manager"],
    recommendedStyles: [{ id: "balanced", level: 4 }, { id: "step-by-step", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Define the question to answer, time-box the investigation, and list evaluation criteria for each option.",
      style: "Present options with pros/cons. Include a recommendation with rationale. Define follow-up actions.",
    },
  },
  {
    id: "planning-release",
    name: "Release Planning",
    description: "Plan release scope, timeline, go/no-go criteria, and rollback.",
    category: "planning",
    recommendedRoles: ["project-manager", "product-manager"],
    recommendedStyles: [{ id: "step-by-step", level: 4 }, { id: "visual", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Include release scope, timeline, go/no-go criteria, rollback plan, and communication plan.",
      style: "Structure as a checklist. Show the release timeline with key dates and responsible parties.",
    },
  },

  // ── UX & Design (4) ──
  {
    id: "design-ux-review",
    name: "UX Heuristic Review",
    description: "Evaluate against Nielsen's 10 heuristics with severity ratings.",
    category: "design",
    recommendedRoles: ["ux-designer"],
    recommendedStyles: [{ id: "visual", level: 3 }, { id: "actionable", level: 4 }],
    builtIn: true,
    fields: {
      constraints: "Evaluate against Nielsen's 10 usability heuristics. Consider accessibility, learnability, and error prevention.",
      style: "Score each heuristic. Show specific violations with severity ratings and suggested fixes.",
    },
  },
  {
    id: "design-system",
    name: "Design System Audit",
    description: "Check component consistency, token usage, and naming conventions.",
    category: "design",
    recommendedRoles: ["ux-designer", "frontend-eng"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "detailed", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Review component consistency, token usage, naming conventions, and pattern reuse.",
      style: "Catalog inconsistencies by category (color, spacing, typography, components). Propose unified tokens.",
    },
  },
  {
    id: "design-user-flow",
    name: "User Flow Mapping",
    description: "Map the full user journey with decision points and drop-off risks.",
    category: "design",
    recommendedRoles: ["ux-designer", "product-manager"],
    recommendedStyles: [{ id: "visual", level: 5 }, { id: "step-by-step", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Map the complete user journey including entry points, decision points, error states, and exit points.",
      style: "Use flowchart-style descriptions. Identify friction points and drop-off risks at each step.",
    },
  },
  {
    id: "design-wireframe",
    name: "Wireframe Description",
    description: "Describe screen layout, hierarchy, and interactions as ASCII/text.",
    category: "design",
    recommendedRoles: ["ux-designer"],
    recommendedStyles: [{ id: "visual", level: 5 }, { id: "detailed", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Describe layout, hierarchy, interactive elements, and responsive behavior. No visual polish — focus on structure.",
      style: "Use ASCII or structured descriptions for each screen. Annotate key interactions and state changes.",
    },
  },

  // ── Prompt Analysis (3) ──
  {
    id: "analysis-error-discovery",
    name: "Error Discovery & Fix",
    description: "Systematically hunt for logic errors, edge cases, and type gaps across the codebase.",
    category: "debugging",
    recommendedRoles: ["debugger", "test-engineer"],
    recommendedStyles: [{ id: "step-by-step", level: 4 }, { id: "diff-format", level: 3 }, { id: "actionable", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Investigate the codebase systematically. Look for logic errors, unhandled edge cases, type safety gaps, race conditions, resource leaks, and broken invariants. Do not report style or cosmetic issues — focus on functional errors. For each error found: explain the root cause, provide the fix, and add or update tests to cover it.",
      style: "For each finding: describe the error, show the buggy code, explain the root cause, show the fix as a diff, and provide the test. Group findings by severity (critical, high, medium).",
    },
  },
  {
    id: "analysis-codebase-health",
    name: "Codebase Health Check",
    description: "Audit for error-prone patterns, missing guards, and silent failures.",
    category: "debugging",
    recommendedRoles: ["code-reviewer", "architect"],
    recommendedStyles: [{ id: "visual", level: 3 }, { id: "actionable", level: 4 }, { id: "step-by-step", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Audit the codebase for error-prone patterns, missing error handling, unsafe assumptions, and fragile code. Check for: null/undefined access without guards, async operations without proper error boundaries, stale closures, missing cleanup in effects or subscriptions, and silent failure paths. Prioritize findings that could cause runtime crashes or data corruption.",
      style: "Present a summary table of findings ranked by risk. For each finding, show the problematic code, explain why it is error-prone, provide the fix as a diff, and list the test cases needed.",
    },
  },
  {
    id: "analysis-test-and-fix",
    name: "Test-Driven Error Hunt",
    description: "Write tests that expose real bugs, then fix the source code.",
    category: "testing",
    recommendedRoles: ["test-engineer", "debugger"],
    recommendedStyles: [{ id: "code-heavy", level: 4 }, { id: "step-by-step", level: 3 }, { id: "diff-format", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Write tests that probe for real bugs — not just coverage padding. Target edge cases, boundary conditions, error paths, and integration seams. When a test reveals an actual bug, fix the source code and keep the test. Use AAA (Arrange-Act-Assert) pattern. Tests must be deterministic and isolated.",
      style: "For each area: write the failing test first, show the error it catches, then show the fix. Group by module or component. End with a summary of bugs found vs tests added.",
    },
  },

  // ── Security (expanded) ──
  {
    id: "sec-secrets",
    name: "Secrets & Credentials Audit",
    description: "Scan for leaked API keys, hardcoded passwords, and .env exposure.",
    category: "security",
    recommendedRoles: ["security-auditor", "devops-eng"],
    recommendedStyles: [{ id: "actionable", level: 4 }, { id: "step-by-step", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Scan for hardcoded secrets, API keys, tokens, passwords, and .env files committed to version control. Check environment variable handling, secret rotation policies, and vault integration.",
      style: "List each finding with file path, line number, and severity. Show the remediation (environment variable, vault reference, etc.) as a diff.",
    },
  },
  {
    id: "sec-compliance",
    name: "Compliance Checklist (SOC2/GDPR)",
    description: "Audit codebase for SOC2, GDPR, or HIPAA compliance gaps.",
    category: "security",
    recommendedRoles: ["security-auditor", "backend-eng"],
    recommendedStyles: [{ id: "formal", level: 4 }, { id: "actionable", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Check for data encryption at rest and in transit, audit logging, access controls, data retention policies, PII handling, consent mechanisms, and right-to-deletion support.",
      style: "Structure as a compliance checklist grouped by framework requirement. Mark each item as pass/fail/partial with remediation steps.",
    },
  },
  {
    id: "sec-rate-limit",
    name: "Rate Limiting & Abuse Prevention",
    description: "Design rate limiting, throttling, and abuse prevention for APIs.",
    category: "security",
    recommendedRoles: ["security-auditor", "backend-eng"],
    recommendedStyles: [{ id: "step-by-step", level: 3 }, { id: "code-heavy", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Identify all public endpoints, authentication flows, and resource-intensive operations. Consider distributed rate limiting, token bucket vs sliding window, and graceful degradation.",
      style: "Map each endpoint to its rate limit policy. Show implementation code for the rate limiter. Include bypass prevention for header spoofing.",
    },
  },

  // ── Architecture (expanded) ──
  {
    id: "arch-event-driven",
    name: "Event-Driven Architecture",
    description: "Design pub/sub, CQRS, or event sourcing for decoupled systems.",
    category: "architecture",
    recommendedRoles: ["architect", "backend-eng"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "step-by-step", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Define event schemas, producers, consumers, and delivery guarantees. Consider idempotency, ordering, dead-letter queues, and eventual consistency tradeoffs.",
      style: "Diagram the event flow. Define each event type with its schema. Show consumer retry and failure handling.",
    },
  },
  {
    id: "arch-caching",
    name: "Caching Strategy",
    description: "Design cache layers, invalidation policies, and consistency tradeoffs.",
    category: "architecture",
    recommendedRoles: ["architect", "backend-eng"],
    recommendedStyles: [{ id: "visual", level: 3 }, { id: "balanced", level: 4 }],
    builtIn: true,
    fields: {
      constraints: "Identify cacheable data, TTLs, invalidation triggers, and cache-aside vs write-through patterns. Consider thundering herd, cache stampede, and stale-while-revalidate.",
      style: "Map each data type to its caching strategy. Show cache hit/miss flow diagrams. Include invalidation logic.",
    },
  },
  {
    id: "arch-scaling",
    name: "Scaling Plan",
    description: "Identify bottlenecks and plan horizontal/vertical scaling strategies.",
    category: "architecture",
    recommendedRoles: ["architect", "devops-eng"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "step-by-step", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Profile current load, identify bottlenecks (CPU, memory, I/O, network), and plan scaling steps. Consider read replicas, sharding, connection pooling, CDN, and auto-scaling policies.",
      style: "Show current architecture with bottleneck markers. Propose phased scaling plan with estimated capacity at each phase.",
    },
  },

  // ── Testing (expanded) ──
  {
    id: "test-e2e",
    name: "E2E Test Scenario",
    description: "Design end-to-end tests for critical user flows with browser automation.",
    category: "testing",
    recommendedRoles: ["test-engineer", "frontend-eng"],
    recommendedStyles: [{ id: "code-heavy", level: 4 }, { id: "step-by-step", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Cover critical user flows end-to-end. Handle async operations, network requests, and dynamic content. Tests must be deterministic and not flaky. Use page object pattern for maintainability.",
      style: "Structure each test as a user scenario with clear setup, steps, and assertions. Show selector strategy and wait conditions.",
    },
  },
  {
    id: "test-load",
    name: "Load Test Plan",
    description: "Define load profiles, thresholds, and breaking points for your service.",
    category: "testing",
    recommendedRoles: ["test-engineer", "devops-eng"],
    recommendedStyles: [{ id: "visual", level: 3 }, { id: "actionable", level: 4 }],
    builtIn: true,
    fields: {
      constraints: "Define realistic load profiles (ramp-up, sustained, spike). Set SLO thresholds for latency, error rate, and throughput. Identify the breaking point and degradation behavior.",
      style: "Show load profile curves. Define pass/fail criteria as a table. Include the test script structure and key scenarios.",
    },
  },

  // ── Documentation (expanded) ──
  {
    id: "doc-rfc",
    name: "Technical RFC / Design Doc",
    description: "Write a structured proposal for technical decisions with alternatives.",
    category: "documentation",
    recommendedRoles: ["architect", "technical-writer"],
    recommendedStyles: [{ id: "formal", level: 3 }, { id: "balanced", level: 4 }],
    builtIn: true,
    fields: {
      constraints: "Include context, problem statement, proposed solution, alternatives considered, migration plan, and open questions. Define success criteria and rollback plan.",
      style: "Use RFC structure: Summary, Motivation, Detailed Design, Alternatives, Unresolved Questions. Be opinionated on the recommendation but fair on alternatives.",
    },
  },
  {
    id: "doc-onboarding",
    name: "Developer Onboarding Guide",
    description: "Write a new-hire guide covering setup, architecture, and key workflows.",
    category: "documentation",
    recommendedRoles: ["technical-writer"],
    recommendedStyles: [{ id: "beginner", level: 4 }, { id: "step-by-step", level: 4 }],
    builtIn: true,
    fields: {
      constraints: "Cover environment setup, project architecture overview, development workflow, testing approach, deployment process, and key contacts. Assume zero prior context.",
      style: "Step-by-step with copy-pasteable commands. Include troubleshooting section for common setup issues. Use a checklist format for the first-day and first-week milestones.",
    },
  },

  // ── Product Management (expanded) ──
  {
    id: "product-gtm",
    name: "Go-to-Market Plan",
    description: "Plan launch strategy, channels, messaging, and timeline.",
    category: "product",
    recommendedRoles: ["product-manager"],
    recommendedStyles: [{ id: "actionable", level: 4 }, { id: "visual", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Define target audience, value proposition, launch channels, messaging, timeline, success metrics, and post-launch iteration plan. Consider early adopter strategy and feedback loops.",
      style: "Structure as a phased timeline (pre-launch, launch day, post-launch). Include channel-specific tactics and messaging templates.",
    },
  },
  {
    id: "product-pricing",
    name: "Pricing Strategy",
    description: "Design pricing tiers, packaging, and competitive positioning.",
    category: "product",
    recommendedRoles: ["product-manager"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "balanced", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Analyze cost structure, willingness to pay, competitor pricing, and value metrics. Design tier structure with clear upgrade triggers. Consider freemium, usage-based, and seat-based models.",
      style: "Present pricing tiers as a comparison table. Show the value ladder. Include competitor benchmark and margin analysis.",
    },
  },
  {
    id: "product-okr",
    name: "OKR Definition",
    description: "Define objectives, key results, and initiatives aligned to strategy.",
    category: "product",
    recommendedRoles: ["product-manager", "project-manager"],
    recommendedStyles: [{ id: "actionable", level: 4 }, { id: "visual", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Objectives must be qualitative and inspiring. Key results must be measurable with clear targets. Initiatives map to key results. Limit to 3-5 objectives with 2-4 KRs each.",
      style: "Structure as Objective → Key Results → Initiatives. Include baseline, target, and stretch values for each KR. Show alignment to company-level goals.",
    },
  },
  {
    id: "product-interview",
    name: "Customer Interview Script",
    description: "Design discovery interview questions with follow-ups and synthesis.",
    category: "product",
    recommendedRoles: ["product-manager", "ux-designer"],
    recommendedStyles: [{ id: "step-by-step", level: 3 }, { id: "actionable", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Use open-ended questions. Avoid leading questions. Follow the 'jobs to be done' framework. Include warm-up, core discovery, and wrap-up phases. Plan for 30-45 minute sessions.",
      style: "Structure as interview phases with primary and follow-up questions. Include a synthesis template for capturing insights, patterns, and action items.",
    },
  },

  // ── Planning (expanded) ──
  {
    id: "planning-techdebt",
    name: "Technical Debt Assessment",
    description: "Catalog, score, and prioritize technical debt for remediation.",
    category: "planning",
    recommendedRoles: ["architect", "project-manager"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "actionable", level: 4 }],
    builtIn: true,
    fields: {
      constraints: "Identify tech debt across code quality, architecture, infrastructure, and dependencies. Score each item by impact (developer velocity, reliability, security) and remediation effort.",
      style: "Present as a scored table with impact vs effort quadrant. Group by category. Recommend a remediation roadmap with quick wins first.",
    },
  },
  {
    id: "planning-capacity",
    name: "Capacity Planning",
    description: "Allocate team capacity across projects, support, and tech debt.",
    category: "planning",
    recommendedRoles: ["project-manager", "product-manager"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "actionable", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Account for team size, velocity, PTO, on-call rotation, and interrupt-driven work. Allocate capacity across features, tech debt, bugs, and support. Flag over-commitment risks.",
      style: "Show capacity as a visual allocation (percentages or hours). Include a burndown forecast. Highlight bottlenecks and single-person dependencies.",
    },
  },
  {
    id: "planning-retro",
    name: "Sprint Retrospective",
    description: "Facilitate a retro with what went well, what didn't, and action items.",
    category: "planning",
    recommendedRoles: ["project-manager"],
    recommendedStyles: [{ id: "actionable", level: 4 }, { id: "balanced", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Cover what went well, what didn't, and what to change. Focus on process improvements, not blame. Each action item must have an owner and due date. Limit to 3-5 actionable takeaways.",
      style: "Structure as three columns: Keep, Stop, Start. Prioritize action items by impact. Include follow-up on previous retro items.",
    },
  },

  // ── DevOps & Infrastructure (5 — NEW CATEGORY) ──
  {
    id: "devops-cicd",
    name: "CI/CD Pipeline Design",
    description: "Design build, test, and deploy stages with rollback triggers.",
    category: "devops",
    recommendedRoles: ["devops-eng", "backend-eng"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "step-by-step", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Define pipeline stages (lint, test, build, deploy), environments (dev, staging, prod), promotion gates, and rollback triggers. Consider parallelization, caching, and secrets management.",
      style: "Diagram the pipeline stages. Show the configuration file structure. Include failure handling and notification setup.",
    },
  },
  {
    id: "devops-container",
    name: "Containerization Review",
    description: "Audit Dockerfiles for size, security, layer caching, and best practices.",
    category: "devops",
    recommendedRoles: ["devops-eng"],
    recommendedStyles: [{ id: "diff-format", level: 4 }, { id: "actionable", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Check for multi-stage builds, minimal base images, non-root users, layer ordering for cache efficiency, .dockerignore, and security scanning. Minimize final image size.",
      style: "Show the current Dockerfile with annotated issues, then the optimized version as a diff. Include image size before/after.",
    },
  },
  {
    id: "devops-infra",
    name: "Infrastructure as Code Review",
    description: "Review Terraform/Pulumi/CDK for drift, cost, and security posture.",
    category: "devops",
    recommendedRoles: ["devops-eng", "security-auditor"],
    recommendedStyles: [{ id: "code-heavy", level: 3 }, { id: "actionable", level: 4 }],
    builtIn: true,
    fields: {
      constraints: "Check for state drift, resource tagging, cost optimization, security group rules, IAM least-privilege, encryption, and backup policies. Verify environment parity.",
      style: "List findings by resource with severity. Show the fix as IaC code diff. Include cost impact estimates where applicable.",
    },
  },
  {
    id: "devops-monitoring",
    name: "Observability Setup",
    description: "Define metrics, alerts, dashboards, and SLOs for a service.",
    category: "devops",
    recommendedRoles: ["devops-eng", "backend-eng"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "step-by-step", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Define the four golden signals (latency, traffic, errors, saturation). Set SLOs with error budgets. Design alerts that are actionable (not noisy). Include logging standards and trace correlation.",
      style: "Structure as: SLOs → Metrics → Alerts → Dashboards. Show alert rules with thresholds. Include a dashboard layout description.",
    },
  },
  {
    id: "devops-runbook",
    name: "Runbook Generation",
    description: "Write step-by-step operational playbooks for known failure modes.",
    category: "devops",
    recommendedRoles: ["devops-eng"],
    recommendedStyles: [{ id: "step-by-step", level: 5 }, { id: "actionable", level: 4 }],
    builtIn: true,
    fields: {
      constraints: "Cover detection (how to know it is happening), diagnosis (how to confirm root cause), mitigation (how to stop the bleeding), resolution (how to fix permanently), and communication (who to notify).",
      style: "Structure as numbered steps a sleep-deprived on-call engineer can follow at 3am. Include exact commands, expected outputs, and decision trees.",
    },
  },

  // ── Data & Analytics (4 — NEW CATEGORY) ──
  {
    id: "data-schema",
    name: "Database Schema Design",
    description: "Design normalized/denormalized schemas with migration strategy.",
    category: "data",
    recommendedRoles: ["database-specialist", "backend-eng"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "code-heavy", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Define tables, columns, types, constraints, indexes, and relationships. Consider normalization level, read vs write patterns, and migration from existing schema. Plan for growth.",
      style: "Show the schema as CREATE TABLE statements or an ERD description. Explain each index choice. Include the migration SQL with rollback.",
    },
  },
  {
    id: "data-pipeline",
    name: "Data Pipeline Design",
    description: "Design ETL/ELT architecture with error handling and idempotency.",
    category: "data",
    recommendedRoles: ["data-analyst", "backend-eng"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "step-by-step", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Define data sources, transformations, destinations, and scheduling. Ensure idempotency, handle schema evolution, implement dead-letter queues, and plan for backfills.",
      style: "Diagram the pipeline stages with data flow. Show transformation logic. Include error handling strategy and monitoring checkpoints.",
    },
  },
  {
    id: "data-query",
    name: "Query Writing & Optimization",
    description: "Write complex analytical queries with performance analysis.",
    category: "data",
    recommendedRoles: ["data-analyst", "database-specialist"],
    recommendedStyles: [{ id: "code-heavy", level: 4 }, { id: "step-by-step", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Write correct, performant SQL for the given analytical question. Use CTEs for readability. Consider index usage, join order, and query plan. Handle NULLs and edge cases explicitly.",
      style: "Build the query step by step, adding complexity incrementally. Show the query plan analysis. Explain each CTE or subquery.",
    },
  },
  {
    id: "data-dashboard",
    name: "Metrics Dashboard Spec",
    description: "Define KPIs, dimensions, filters, and visualization types.",
    category: "data",
    recommendedRoles: ["data-analyst", "product-manager"],
    recommendedStyles: [{ id: "visual", level: 5 }, { id: "actionable", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Define each metric with its formula, data source, granularity, and refresh frequency. Group by business area. Include drill-down dimensions and filter options.",
      style: "Describe the dashboard layout section by section. For each chart: metric name, chart type, axes, filters, and the underlying query logic.",
    },
  },

  // ── AI & ML (4 — NEW CATEGORY) ──
  {
    id: "ai-prompt-eng",
    name: "Prompt Engineering",
    description: "Design, test, and iterate on LLM prompts with evaluation criteria.",
    category: "ai-ml",
    recommendedRoles: ["ml-engineer"],
    recommendedStyles: [{ id: "step-by-step", level: 3 }, { id: "code-heavy", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Define the task, desired output format, edge cases, and evaluation criteria. Test with diverse inputs. Consider few-shot examples, chain-of-thought, and output parsing. Measure quality systematically.",
      style: "Show the prompt evolution: v1 → issues found → v2 → improvements. Include test cases with expected vs actual output. End with the final prompt and evaluation rubric.",
    },
  },
  {
    id: "ai-eval",
    name: "AI/ML Evaluation Plan",
    description: "Define test sets, metrics, baselines, and regression checks for AI features.",
    category: "ai-ml",
    recommendedRoles: ["ml-engineer", "test-engineer"],
    recommendedStyles: [{ id: "visual", level: 3 }, { id: "actionable", level: 4 }],
    builtIn: true,
    fields: {
      constraints: "Define evaluation datasets (golden sets), metrics (accuracy, latency, cost), baselines, and acceptable regression thresholds. Consider bias, fairness, and edge case coverage.",
      style: "Structure as: Metrics → Dataset → Baseline → Pass/Fail Criteria. Show evaluation results as a scorecard. Include automated regression test setup.",
    },
  },
  {
    id: "ai-integration",
    name: "LLM Integration Architecture",
    description: "Design RAG pipelines, caching, fallbacks, and cost controls for LLM apps.",
    category: "ai-ml",
    recommendedRoles: ["ml-engineer", "architect"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "balanced", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Design the LLM call chain including retrieval, prompt assembly, model selection, response parsing, caching, fallback providers, rate limiting, and cost tracking. Plan for model upgrades and A/B testing.",
      style: "Diagram the request flow from user input to final response. Show each component with its purpose. Include cost estimation per request and monthly projections.",
    },
  },
  {
    id: "ai-agent-design",
    name: "Agent Workflow Design",
    description: "Design multi-step agent flows with tool use, guardrails, and error recovery.",
    category: "ai-ml",
    recommendedRoles: ["ml-engineer", "architect"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "step-by-step", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Define the agent's goal, available tools, decision logic, and termination conditions. Include guardrails for safety, cost limits, and human-in-the-loop checkpoints. Plan for loops, failures, and hallucination detection.",
      style: "Show the agent loop as a state machine or flowchart. Define each tool with its input/output schema. Include error recovery and maximum iteration limits.",
    },
  },

  // ── Incident Response (4 — NEW CATEGORY) ──
  {
    id: "incident-postmortem",
    name: "Incident Postmortem",
    description: "Write a blameless postmortem with timeline, root cause, and action items.",
    category: "incident",
    recommendedRoles: ["devops-eng", "backend-eng"],
    recommendedStyles: [{ id: "formal", level: 3 }, { id: "step-by-step", level: 4 }],
    builtIn: true,
    fields: {
      constraints: "Be blameless. Include incident summary, impact (duration, users affected, revenue), timeline of events, root cause analysis (5 Whys), contributing factors, and action items with owners and deadlines.",
      style: "Structure as: Summary → Impact → Timeline → Root Cause → Contributing Factors → Action Items → Lessons Learned. Timeline should be minute-by-minute during the incident.",
    },
  },
  {
    id: "incident-response",
    name: "Incident Response Plan",
    description: "Define severity levels, escalation paths, and communication templates.",
    category: "incident",
    recommendedRoles: ["devops-eng", "project-manager"],
    recommendedStyles: [{ id: "actionable", level: 5 }, { id: "step-by-step", level: 4 }],
    builtIn: true,
    fields: {
      constraints: "Define severity levels (P0-P3) with criteria, response time SLAs, escalation paths, roles (incident commander, comms lead, tech lead), and communication templates for internal and external stakeholders.",
      style: "Structure as a quick-reference guide. Use tables for severity definitions. Include copy-pasteable communication templates. Show the escalation flowchart.",
    },
  },
  {
    id: "incident-sla",
    name: "SLA/SLO Definition",
    description: "Define reliability targets, error budgets, and alerting thresholds.",
    category: "incident",
    recommendedRoles: ["devops-eng", "product-manager"],
    recommendedStyles: [{ id: "visual", level: 3 }, { id: "formal", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Define SLIs (what to measure), SLOs (target values), and SLAs (contractual obligations). Calculate error budgets. Define what happens when error budget is exhausted (feature freeze, reliability sprint).",
      style: "Present as a table of SLI → SLO → SLA for each service. Show error budget burn rate calculations. Include alerting thresholds tied to SLOs.",
    },
  },
  {
    id: "incident-chaos",
    name: "Chaos Engineering Plan",
    description: "Design controlled failure experiments to discover system weaknesses.",
    category: "incident",
    recommendedRoles: ["devops-eng", "architect"],
    recommendedStyles: [{ id: "step-by-step", level: 4 }, { id: "balanced", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Define steady state hypothesis, experiment scope, blast radius controls, abort conditions, and expected vs actual behavior. Start small (single service) and expand. Never run in production without rollback capability.",
      style: "Structure each experiment as: Hypothesis → Method → Blast Radius → Abort Criteria → Results → Follow-up. Rank experiments by risk and learning value.",
    },
  },

  // ── Business & Growth (4 — NEW CATEGORY) ──
  {
    id: "biz-pitch",
    name: "Pitch Deck Outline",
    description: "Structure a pitch deck with problem, solution, market, traction, and ask.",
    category: "business",
    recommendedRoles: ["product-manager"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "concise", level: 4 }],
    builtIn: true,
    fields: {
      constraints: "Cover: Problem, Solution, Market Size (TAM/SAM/SOM), Business Model, Traction, Competition, Team, Financials, and Ask. Keep each slide to one key message. Target 10-12 slides total.",
      style: "Describe each slide with its headline, key message, and supporting data points. Keep it concise — investors spend 3 minutes per deck. Lead with the strongest traction metric.",
    },
  },
  {
    id: "biz-investor-update",
    name: "Investor Update",
    description: "Write a monthly investor update with metrics, wins, challenges, and asks.",
    category: "business",
    recommendedRoles: ["product-manager"],
    recommendedStyles: [{ id: "concise", level: 4 }, { id: "visual", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Include key metrics (MRR, growth, burn, runway), highlights, lowlights, key hires, product milestones, and specific asks (intros, hiring, advice). Be transparent about challenges.",
      style: "Structure as: TL;DR → Metrics → Wins → Challenges → Product → Team → Asks. Use bullet points. Include month-over-month trends for key metrics.",
    },
  },
  {
    id: "biz-experiment",
    name: "Growth Experiment Design",
    description: "Design a hypothesis-driven growth experiment with metrics and sample size.",
    category: "business",
    recommendedRoles: ["product-manager", "data-analyst"],
    recommendedStyles: [{ id: "actionable", level: 4 }, { id: "step-by-step", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Define hypothesis, primary metric, secondary metrics, target lift, sample size, experiment duration, and success criteria. Consider statistical significance, novelty effects, and segment analysis.",
      style: "Structure as: Hypothesis → Metric → Variant Design → Sample Size Calculation → Duration → Success Criteria → Analysis Plan. Include the decision framework for ship/iterate/kill.",
    },
  },
  {
    id: "biz-funnel",
    name: "Funnel Analysis",
    description: "Define funnel stages, measure conversion, and identify drop-off points.",
    category: "business",
    recommendedRoles: ["data-analyst", "product-manager"],
    recommendedStyles: [{ id: "visual", level: 5 }, { id: "actionable", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Define each funnel stage with entry/exit criteria. Measure conversion rates between stages. Identify the highest-impact drop-off points. Segment by acquisition channel, cohort, and user type.",
      style: "Show the funnel as a visual with conversion rates at each step. Highlight the biggest leaks. Propose specific interventions ranked by expected lift.",
    },
  },

  // ── Migrated v1 templates ──
  {
    id: "bug-fix",
    name: "Bug Fix",
    description: "Diagnose and apply a minimal, targeted fix with a diff.",
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
    description: "Break down code or concepts step by step at the right level.",
    category: "documentation",
    recommendedRoles: ["technical-writer"],
    recommendedStyles: [{ id: "step-by-step", level: 3 }, { id: "beginner", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Explain at the appropriate level of abstraction for the audience.",
      style: "Use step-by-step explanations with examples. Start with a high-level overview, then dive into details.",
    },
  },

  // ── Monetization ──
  {
    id: "monetize-revenue-model",
    name: "Revenue Model Design",
    description: "Evaluate and design revenue models: subscription, usage-based, marketplace, or hybrid.",
    category: "monetization",
    recommendedRoles: ["product-manager"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "balanced", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Analyze the product value chain and where value is captured. Compare revenue models (subscription, usage-based, marketplace, transaction-based, advertising, data licensing). For each, estimate TAM capture, revenue predictability, and implementation complexity. Recommend a primary + secondary model with rationale.",
      style: "Present a comparison matrix of revenue models. Highlight the recommended model with a clear justification tied to the product's value proposition and customer behavior patterns.",
    },
  },
  {
    id: "monetize-unit-economics",
    name: "Unit Economics Analysis",
    description: "Calculate and optimize LTV, CAC, payback period, and contribution margin.",
    category: "monetization",
    recommendedRoles: ["data-analyst", "product-manager"],
    recommendedStyles: [{ id: "visual", level: 5 }, { id: "detailed", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Calculate: Customer Acquisition Cost (CAC) by channel, Lifetime Value (LTV) with cohort analysis, LTV:CAC ratio (target >3x), payback period in months, gross margin per customer, contribution margin. Segment by plan tier, acquisition channel, and cohort. Flag unit economics that don't work at scale.",
      style: "Show formulas, then calculated results in a clear table. Visualize LTV:CAC by segment. Highlight the most profitable segments and the ones that need fixing.",
    },
  },
  {
    id: "monetize-churn-analysis",
    name: "Churn & Retention Strategy",
    description: "Analyze churn patterns, identify at-risk segments, and design retention interventions.",
    category: "monetization",
    recommendedRoles: ["data-analyst", "product-manager"],
    recommendedStyles: [{ id: "actionable", level: 4 }, { id: "visual", level: 4 }],
    builtIn: true,
    fields: {
      constraints: "Segment churn by: voluntary vs involuntary, plan tier, tenure cohort, usage pattern, and acquisition channel. Identify leading indicators of churn (usage drop, support tickets, feature non-adoption). Design interventions: onboarding improvements, health score triggers, win-back campaigns, pricing adjustments, and involuntary churn recovery (dunning).",
      style: "Start with churn metrics overview. Then show a cohort retention curve. Identify the critical drop-off points and propose specific, prioritized interventions with expected impact.",
    },
  },
  {
    id: "monetize-paywall",
    name: "Paywall & Conversion Optimization",
    description: "Design paywall strategy, free-to-paid triggers, and conversion experiments.",
    category: "monetization",
    recommendedRoles: ["product-manager", "ux-designer"],
    recommendedStyles: [{ id: "actionable", level: 4 }, { id: "step-by-step", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Define what's free vs paid (feature gating, usage limits, time trials). Design the upgrade trigger moments (aha moments, limit hits, social proof). Plan the conversion page: pricing display, plan comparison, social proof, objection handling, CTA placement. Propose A/B tests for pricing page, trial length, and feature gates.",
      style: "Structure as: Current state → Proposed paywall strategy → Conversion page wireframe → Experiment roadmap. Be specific about what triggers the upgrade prompt and why.",
    },
  },
  {
    id: "monetize-subscription-lifecycle",
    name: "Subscription Lifecycle Design",
    description: "Map the full subscriber journey from trial to expansion to renewal.",
    category: "monetization",
    recommendedRoles: ["product-manager"],
    recommendedStyles: [{ id: "visual", level: 4 }, { id: "step-by-step", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Map lifecycle stages: Awareness → Trial → Activation → Conversion → Engagement → Expansion → Renewal. For each stage define: key actions, success metrics, automated triggers, email/in-app touchpoints, and risk signals. Include trial-to-paid optimization, expansion revenue (upsell/cross-sell), and renewal/cancellation flows.",
      style: "Present as a lifecycle journey map with stages, metrics, and interventions at each point. Highlight the highest-leverage moments for revenue impact.",
    },
  },
  {
    id: "monetize-pricing-experiment",
    name: "Pricing Experiment Design",
    description: "Design and analyze pricing experiments: A/B tests, willingness-to-pay studies, and tier optimization.",
    category: "monetization",
    recommendedRoles: ["product-manager", "data-analyst"],
    recommendedStyles: [{ id: "step-by-step", level: 4 }, { id: "actionable", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Choose experiment type: Van Westendorp, Gabor-Granger, conjoint analysis, or live A/B test. Define hypothesis, metrics (ARPU, conversion rate, revenue per visitor), sample size, duration, and segmentation. Address risks: price anchoring, fairness perception, grandfathering existing customers, and legal/contractual constraints.",
      style: "Structure as: Hypothesis → Method → Design → Analysis Plan → Decision Framework. Include a clear go/no-go decision tree based on results.",
    },
  },
  {
    id: "monetize-expansion-revenue",
    name: "Expansion Revenue Playbook",
    description: "Design upsell, cross-sell, and add-on strategies to grow revenue from existing customers.",
    category: "monetization",
    recommendedRoles: ["product-manager"],
    recommendedStyles: [{ id: "actionable", level: 4 }, { id: "visual", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Identify expansion levers: seat-based growth, tier upgrades, add-on modules, usage overage, and professional services. For each lever: define the trigger event, target segment, messaging, and expected revenue impact. Calculate net revenue retention (NRR) target. Design the in-product upgrade prompts and sales-assist handoff points.",
      style: "Present a menu of expansion plays ranked by revenue impact and implementation effort. Include specific trigger conditions and messaging for each play.",
    },
  },

  // ── Legal & Compliance (8) ──
  {
    id: "legal-privacy-policy",
    name: "Privacy Policy Generator",
    description: "Draft a comprehensive privacy policy for an app, SaaS product, or website.",
    category: "legal",
    recommendedRoles: ["legal-advisor", "technical-writer"],
    recommendedStyles: [{ id: "detailed", level: 4 }, { id: "formal", level: 4 }],
    builtIn: true,
    fields: {
      constraints: "Cover all required sections: data collected (personal, usage, cookies), legal basis for processing, third-party sharing, user rights (access, deletion, portability), retention periods, children's data, international transfers, and contact info. Comply with GDPR, CCPA, and other applicable regulations. Use plain language where possible.",
      style: "Structure with clear section headings. Use plain-language summaries followed by legal detail. Include a table of contents.",
    },
  },
  {
    id: "legal-terms-of-service",
    name: "Terms of Service",
    description: "Draft terms of service / terms of use for a digital product.",
    category: "legal",
    recommendedRoles: ["legal-advisor", "technical-writer"],
    recommendedStyles: [{ id: "detailed", level: 4 }, { id: "formal", level: 4 }],
    builtIn: true,
    fields: {
      constraints: "Cover: acceptance of terms, account registration, acceptable use policy, intellectual property, user-generated content, payment/billing terms (if applicable), limitation of liability, warranty disclaimers, termination, dispute resolution, governing law, and modification of terms. Balance legal protection with user readability.",
      style: "Use numbered sections with descriptive headings. Plain-language summary at the top. Bold key obligations and restrictions.",
    },
  },
  {
    id: "legal-document-review",
    name: "Legal Document Review",
    description: "Review a legal document for risks, ambiguities, and missing clauses.",
    category: "legal",
    recommendedRoles: ["legal-advisor", "security-auditor"],
    recommendedStyles: [{ id: "step-by-step", level: 3 }, { id: "actionable", level: 4 }],
    builtIn: true,
    fields: {
      constraints: "Identify: risky clauses, ambiguous language, missing protections, unfavorable terms, compliance gaps, and enforceability concerns. Rate each finding by severity (critical, major, minor). Suggest specific rewording for problematic clauses.",
      style: "Present findings in a severity-ranked table with: clause reference, issue description, risk level, and recommended fix. End with a summary of overall risk posture.",
    },
  },
  {
    id: "legal-contract-analysis",
    name: "Contract Clause Analysis",
    description: "Analyze specific contract clauses for fairness, enforceability, and hidden risks.",
    category: "legal",
    recommendedRoles: ["legal-advisor"],
    recommendedStyles: [{ id: "detailed", level: 3 }, { id: "balanced", level: 4 }],
    builtIn: true,
    fields: {
      constraints: "For each clause: explain what it means in plain language, identify who it favors, flag enforceability risks by jurisdiction, compare to market-standard language, and suggest alternative wording if unfavorable. Consider interaction effects between clauses.",
      style: "Analyze clause-by-clause. For each: plain-language meaning, risk assessment, market comparison, and recommended revision. Use a fairness rating scale.",
    },
  },
  {
    id: "legal-gdpr-audit",
    name: "GDPR / Data Protection Audit",
    description: "Audit a product or codebase for GDPR, CCPA, and data protection compliance.",
    category: "legal",
    recommendedRoles: ["legal-advisor", "security-auditor"],
    recommendedStyles: [{ id: "step-by-step", level: 4 }, { id: "actionable", level: 4 }],
    builtIn: true,
    fields: {
      constraints: "Check: lawful basis for processing, consent mechanisms, data minimization, right to erasure implementation, data portability, breach notification procedures, DPA/sub-processor agreements, cross-border transfer safeguards, cookie consent, and record of processing activities. Reference specific GDPR articles and CCPA sections.",
      style: "Use a compliance checklist format with pass/fail/partial status for each requirement. Include specific code or process changes needed for each gap.",
    },
  },
  {
    id: "legal-software-license",
    name: "Software License Advisor",
    description: "Choose, compare, or review open-source and proprietary software licenses.",
    category: "legal",
    recommendedRoles: ["legal-advisor", "architect"],
    recommendedStyles: [{ id: "balanced", level: 4 }, { id: "visual", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Compare licenses on: permissions (commercial use, modification, distribution), conditions (disclosure, same license, state changes), limitations (liability, warranty), patent grants, and compatibility with other licenses. Consider the project's use case: library, SaaS, desktop app, or internal tool.",
      style: "Present a comparison table of candidate licenses. For each: key permissions, restrictions, and compatibility notes. End with a clear recommendation based on the project context.",
    },
  },
  {
    id: "legal-eula",
    name: "EULA Generator",
    description: "Draft an End User License Agreement for a desktop, mobile, or SaaS application.",
    category: "legal",
    recommendedRoles: ["legal-advisor", "technical-writer"],
    recommendedStyles: [{ id: "detailed", level: 4 }, { id: "formal", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Cover: license grant and scope, restrictions (reverse engineering, redistribution, sublicensing), intellectual property ownership, automatic updates, data collection, warranty disclaimer, limitation of liability, termination conditions, and governing law. Distinguish between subscription-based and perpetual license models if relevant.",
      style: "Use numbered sections. Start each section with a one-sentence plain-language summary. Keep legal language precise but avoid unnecessary jargon.",
    },
  },
  {
    id: "legal-cookie-consent",
    name: "Cookie & Consent Policy",
    description: "Draft a cookie policy and design a consent mechanism compliant with ePrivacy and GDPR.",
    category: "legal",
    recommendedRoles: ["legal-advisor", "frontend-eng"],
    recommendedStyles: [{ id: "actionable", level: 4 }, { id: "step-by-step", level: 3 }],
    builtIn: true,
    fields: {
      constraints: "Cover: types of cookies used (strictly necessary, functional, analytics, advertising), purpose of each cookie, duration and expiry, third-party cookies, consent collection mechanism (banner design, granular opt-in), consent storage and proof, withdrawal of consent, and cookie-less alternatives. Comply with ePrivacy Directive, GDPR, and CCPA cookie requirements.",
      style: "Split into two parts: (1) the cookie policy document text, and (2) the technical implementation guide for the consent banner. Include a cookie inventory table.",
    },
  },

  // ── End-to-End Feature Development ──
  {
    id: "product-feature-e2e",
    name: "Feature Development (End-to-End)",
    description: "Take a single feature from discovery through PM spec, UX design, implementation plan, and code — all in one pass.",
    category: "product",
    recommendedRoles: ["product-manager", "ux-designer", "fullstack-eng"],
    recommendedStyles: [{ id: "step-by-step", level: 4 }, { id: "actionable", level: 4 }, { id: "detailed", level: 3 }],
    builtIn: true,
    fields: {
      task: "Develop the following feature end-to-end, covering every phase from investigation to working code.",
      constraints: "Work through each phase in order — do not skip ahead:\n\n1. **Discovery & Research** — State the problem. Who is affected? What evidence or user feedback supports this? List assumptions to validate.\n2. **Product Spec** — Define the goal, success metrics, user stories (As a … I want … so that …), acceptance criteria, and out-of-scope items.\n3. **UX & Design** — Describe the user flow step by step, key screens or UI states (use ASCII wireframes where helpful), edge cases, error states, and accessibility considerations.\n4. **Technical Investigation** — Identify affected areas of the codebase, dependencies, risks, and open questions. Propose the approach and flag alternatives you considered.\n5. **Implementation Plan** — Break the work into ordered tasks with clear scope per task. Note which tasks can be parallelized.\n6. **Implementation** — Write the code. Show complete diffs or new files. Follow existing project conventions.\n7. **Verification** — Describe how to test the feature: manual QA steps, edge cases to verify, and any automated tests to add.",
      style: "Use clear section headings for each phase. Keep each phase focused — finish one before moving to the next. Prefer concrete examples over abstract descriptions. Show code as diffs when modifying existing files.",
    },
  },
  {
    id: "product-seo-audit",
    name: "SEO Audit & Optimization",
    description: "Audit a site or page for SEO issues and generate optimized metadata, structured data, and content recommendations.",
    category: "product",
    recommendedRoles: ["product-manager", "fullstack-eng"],
    recommendedStyles: [{ id: "actionable", level: 4 }, { id: "detailed", level: 3 }, { id: "visual", level: 2 }],
    builtIn: true,
    fields: {
      task: "Perform a comprehensive SEO audit and generate optimized metadata for the target page or site.",
      constraints: "Cover each area systematically:\n\n1. **Meta Tags** — Review and optimize title (50-60 chars), meta description (150-160 chars), and canonical URL. Ensure each page has unique, keyword-rich metadata.\n2. **Open Graph & Twitter Cards** — Generate og:title, og:description, og:image (1200×630), og:type, twitter:card, twitter:title, twitter:description, twitter:image. Verify image dimensions and alt text.\n3. **Structured Data (JSON-LD)** — Add or improve schema.org markup (WebSite, SoftwareApplication, Article, BreadcrumbList, FAQ, Organization, etc.) appropriate for the page type. Validate against Google Rich Results requirements.\n4. **Sitemap & Robots** — Verify sitemap.xml includes all public routes with correct changefreq/priority. Check robots.txt allows crawling of important paths and blocks irrelevant ones.\n5. **Headings & Content Structure** — Ensure a single H1 per page, logical heading hierarchy (H1→H2→H3), and keyword presence in headings.\n6. **Performance Signals** — Check for Core Web Vitals concerns: image optimization (WebP/AVIF, srcset, lazy loading), render-blocking resources, font loading strategy.\n7. **Accessibility & Crawlability** — Verify alt text on images, semantic HTML, internal linking, and clean URL structure.\n8. **Keyword Strategy** — Suggest primary and secondary keywords based on page intent. Recommend keyword placement in title, headings, first paragraph, and URL slug.",
      style: "Present findings as a prioritized checklist: critical issues first, then improvements, then nice-to-haves. For each item show the current state, the issue, and the recommended fix with ready-to-use code or markup.",
    },
  },
  {
    id: "product-landing-page-seo",
    name: "Landing Page SEO Copy",
    description: "Write SEO-optimized copy for a landing page including headlines, descriptions, and CTAs targeting specific keywords.",
    category: "product",
    recommendedRoles: ["product-manager"],
    recommendedStyles: [{ id: "actionable", level: 4 }, { id: "balanced", level: 3 }],
    builtIn: true,
    fields: {
      task: "Write SEO-optimized copy for a landing page, targeting the specified keywords and audience.",
      constraints: "Deliver all of the following:\n\n1. **Page Title Tag** — Under 60 characters, primary keyword near the front, compelling and click-worthy.\n2. **Meta Description** — 150-160 characters, includes primary keyword, has a clear call to action.\n3. **H1 Headline** — One per page, includes primary keyword naturally, speaks to the user's intent.\n4. **Supporting Headlines (H2s)** — 3-5 section headings that cover secondary keywords and map to user questions.\n5. **Hero Copy** — 2-3 sentences below the H1 that communicate the core value proposition and include the primary keyword.\n6. **Section Copy** — Short paragraphs (2-4 sentences each) for each H2 section, weaving in secondary keywords naturally.\n7. **CTA Copy** — Primary and secondary call-to-action button text and surrounding microcopy.\n8. **Alt Text** — Suggested alt text for key images (hero, feature screenshots, etc.).\n\nAll copy must read naturally — no keyword stuffing. Prioritize clarity and conversion over keyword density.",
      style: "Present as a page outline with all copy ready to paste. Mark primary and secondary keywords inline. Include a brief SEO rationale for key decisions.",
    },
  },
];

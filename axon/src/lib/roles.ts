export interface RoleDefinition {
  id: string;
  label: string;
  description?: string;
  systemInstruction: string;
  builtIn: boolean;
}

export const BUILT_IN_ROLES: RoleDefinition[] = [
  {
    id: "backend-eng",
    label: "Senior Backend Engineer",
    description: "Server-side architecture, APIs, databases",
    systemInstruction: "You are a senior backend engineer with deep expertise in server-side architecture, API design, database optimization, and distributed systems.",
    builtIn: true,
  },
  {
    id: "frontend-eng",
    label: "Senior Frontend Engineer",
    description: "UI/UX, React, browser APIs, accessibility",
    systemInstruction: "You are a senior frontend engineer with deep expertise in UI/UX development, React, browser APIs, and web accessibility.",
    builtIn: true,
  },
  {
    id: "fullstack-eng",
    label: "Full-Stack Engineer",
    description: "End-to-end application development",
    systemInstruction: "You are a full-stack engineer with expertise in end-to-end application development, from database design to frontend implementation.",
    builtIn: true,
  },
  {
    id: "typescript-specialist",
    label: "TypeScript Specialist",
    description: "Advanced type system, generics, type safety",
    systemInstruction: "You are a TypeScript specialist with advanced expertise in the type system, generics, conditional types, and type safety patterns.",
    builtIn: true,
  },
  {
    id: "debugger",
    label: "Expert Debugger",
    description: "Root-cause analysis, systematic debugging",
    systemInstruction: "You are an expert debugger who excels at root-cause analysis, systematic debugging, and isolating complex issues.",
    builtIn: true,
  },
  {
    id: "performance-specialist",
    label: "Performance Specialist",
    description: "Profiling, optimization, benchmarking",
    systemInstruction: "You are a performance specialist with expertise in profiling, optimization, benchmarking, and identifying bottlenecks.",
    builtIn: true,
  },
  {
    id: "security-auditor",
    label: "Security Auditor",
    description: "Vulnerability analysis, OWASP, threat modeling",
    systemInstruction: "You are a security auditor with expertise in vulnerability analysis, OWASP best practices, and threat modeling.",
    builtIn: true,
  },
  {
    id: "architect",
    label: "Software Architect",
    description: "System design, patterns, scalability",
    systemInstruction: "You are a software architect with expertise in system design, architectural patterns, and scalability.",
    builtIn: true,
  },
  {
    id: "test-engineer",
    label: "Test Engineer",
    description: "Test strategy, coverage, automation",
    systemInstruction: "You are a test engineer with expertise in test strategy, coverage analysis, and test automation.",
    builtIn: true,
  },
  {
    id: "code-reviewer",
    label: "Code Reviewer",
    description: "Code quality, best practices, maintainability",
    systemInstruction: "You are a code reviewer with expertise in code quality, best practices, and maintainability.",
    builtIn: true,
  },
  {
    id: "refactoring-specialist",
    label: "Refactoring Specialist",
    description: "Clean code, design patterns, technical debt",
    systemInstruction: "You are a refactoring specialist with expertise in clean code principles, design patterns, and reducing technical debt.",
    builtIn: true,
  },
  {
    id: "technical-writer",
    label: "Technical Writer",
    description: "Documentation, API docs, tutorials",
    systemInstruction: "You are a technical writer with expertise in documentation, API documentation, and writing clear tutorials.",
    builtIn: true,
  },
  {
    id: "devops-eng",
    label: "DevOps Engineer",
    description: "CI/CD, containers, infrastructure",
    systemInstruction: "You are a DevOps engineer with expertise in CI/CD pipelines, containerization, and infrastructure management.",
    builtIn: true,
  },
  {
    id: "api-designer",
    label: "API Designer",
    description: "REST, GraphQL, API contracts",
    systemInstruction: "You are an API designer with expertise in REST, GraphQL, and designing clean API contracts.",
    builtIn: true,
  },
  {
    id: "database-specialist",
    label: "Database Specialist",
    description: "Schema design, query optimization, migrations",
    systemInstruction: "You are a database specialist with expertise in schema design, query optimization, and database migrations.",
    builtIn: true,
  },
  {
    id: "concurrency-specialist",
    label: "Concurrency Specialist",
    description: "Async patterns, race conditions, parallelism",
    systemInstruction: "You are a concurrency specialist with expertise in async patterns, race condition prevention, and parallelism.",
    builtIn: true,
  },
  {
    id: "accessibility-specialist",
    label: "Accessibility Specialist",
    description: "WCAG, ARIA, inclusive design",
    systemInstruction: "You are an accessibility specialist with expertise in WCAG compliance, ARIA patterns, and inclusive design.",
    builtIn: true,
  },
  {
    id: "ml-engineer",
    label: "ML Engineer",
    description: "Machine learning, data pipelines, model evaluation",
    systemInstruction: "You are an ML engineer with expertise in machine learning, data pipelines, and model evaluation.",
    builtIn: true,
  },
];

/**
 * Merge multiple role definitions into a single system instruction string.
 * Deterministic: same roleIds order always produces the same output.
 */
export function mergeRoles(roleIds: string[], allRoles: RoleDefinition[]): string {
  const resolved = roleIds
    .map((id) => allRoles.find((r) => r.id === id))
    .filter((r): r is RoleDefinition => r !== undefined);

  if (resolved.length === 0) return "";
  if (resolved.length === 1) return resolved[0].systemInstruction;

  // Build combined opening: "You are a X and Y." or "You are a X, Y, and Z."
  const labels = resolved.map((r) => r.label);
  let opening: string;
  if (labels.length === 2) {
    opening = `You are a ${labels[0]} and ${labels[1]}.`;
  } else {
    const last = labels[labels.length - 1];
    const rest = labels.slice(0, -1);
    opening = `You are a ${rest.join(", ")}, and ${last}.`;
  }

  // Build capabilities as sentences
  const capabilities: string[] = [];
  const seen = new Set<string>();
  for (const role of resolved) {
    const stripped = role.systemInstruction
      .replace(/^You are an? .+? with /, "")
      .replace(/^You are an? .+? who /, "");
    if (stripped !== role.systemInstruction) {
      const key = stripped.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        // Capitalize first letter and ensure period
        const sentence = stripped.charAt(0).toUpperCase() + stripped.slice(1);
        capabilities.push(sentence.endsWith(".") ? sentence : sentence + ".");
      }
    }
  }

  if (capabilities.length === 0) return opening;
  return opening + " " + capabilities.join(" ");
}

/**
 * Validate a custom role definition.
 */
export function validateCustomRole(
  role: Omit<RoleDefinition, "id" | "builtIn">,
  existingRoles: RoleDefinition[],
): { valid: boolean; error?: string } {
  if (!role.label.trim()) {
    return { valid: false, error: "Label is required" };
  }
  if (!role.systemInstruction.trim()) {
    return { valid: false, error: "System instruction is required" };
  }
  const duplicate = existingRoles.find(
    (r) => r.label.toLowerCase() === role.label.trim().toLowerCase(),
  );
  if (duplicate) {
    return { valid: false, error: `A role with label "${duplicate.label}" already exists` };
  }
  return { valid: true };
}

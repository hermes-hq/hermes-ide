import { getProjectContext } from "../../api/intelligence";

export interface ProjectContext {
  hasGit: boolean;
  packageManager: "npm" | "yarn" | "pnpm" | "bun" | null;
  languages: string[];
  frameworks: string[];
}

const contextCache = new Map<string, ProjectContext>();

/** Detect project context for a given CWD. Caches per path. */
export async function detectProjectContext(cwd: string): Promise<ProjectContext> {
  const cached = contextCache.get(cwd);
  if (cached) return cached;

  try {
    const ctx = await getProjectContext(cwd);
    contextCache.set(cwd, ctx);
    return ctx;
  } catch {
    // Do NOT cache error fallbacks — a temporary failure (network, backend)
    // should not permanently poison the cache for this CWD.
    return {
      hasGit: false,
      packageManager: null,
      languages: [],
      frameworks: [],
    };
  }
}

/** Invalidate cache for a CWD (called on cwd-changed) */
export function invalidateContext(cwd: string): void {
  contextCache.delete(cwd);
}

/** Get cached context without async call */
export function getCachedContext(cwd: string): ProjectContext | null {
  return contextCache.get(cwd) ?? null;
}

/** Check if a command category is relevant to the current project context */
export function isContextRelevant(category: string, context: ProjectContext): boolean {
  // System commands are always relevant
  if (category === "system" || category === "brew" || category === "gh") return true;

  // Git commands relevant if git repo
  if (category === "git" && context.hasGit) return true;

  // Package manager match
  if (category === "npm" && context.packageManager === "npm") return true;
  if (category === "yarn" && context.packageManager === "yarn") return true;
  if (category === "pnpm" && context.packageManager === "pnpm") return true;
  if (category === "bun" && context.packageManager === "bun") return true;

  // Language match
  if (category === "cargo" && context.languages.includes("rust")) return true;
  if (category === "python" && context.languages.includes("python")) return true;
  if (category === "go" && context.languages.includes("go")) return true;
  if (category === "typescript" && context.languages.includes("typescript")) return true;

  // Framework match
  if (context.frameworks.includes(category)) return true;

  // Check if any context string matches
  if (category === "docker" && context.frameworks.includes("docker")) return true;
  if (category === "k8s" && context.frameworks.includes("k8s")) return true;
  if (category === "make" && context.frameworks.includes("make")) return true;

  return false;
}

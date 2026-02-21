import { useMemo, useCallback, useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SessionData, MemoryFact } from "../state/SessionContext";

interface ContextPin {
  id: number;
  kind: string;
  target: string;
  label: string | null;
}

interface ErrorResolution {
  fingerprint: string;
  resolution: string;
  occurrence_count: number;
}

interface RealmContextInfo {
  realm_name: string;
  languages: string[];
  frameworks: string[];
  architecture_pattern: string | null;
  conventions: string[];
}

interface ContextBundle {
  pins: ContextPin[];
  memoryFacts: MemoryFact[];
  recentErrors: string[];
  errorResolutions: ErrorResolution[];
  filesTouched: string[];
  workingDirectory: string;
  agent: string | null;
  realms: RealmContextInfo[];
}

export function useContextBundle(session: SessionData | null) {
  const [pins, setPins] = useState<ContextPin[]>([]);
  const [errorResolutions, setErrorResolutions] = useState<ErrorResolution[]>([]);
  const [realmContexts, setRealmContexts] = useState<RealmContextInfo[]>([]);

  useEffect(() => {
    if (!session) return;
    invoke("get_context_pins", { sessionId: session.id, projectId: null })
      .then((entries) => setPins(entries as ContextPin[]))
      .catch(() => {});
    invoke("get_error_resolutions", { projectId: session.working_directory, limit: 10 })
      .then((entries) => {
        const patterns = entries as { fingerprint: string; resolution: string | null; occurrence_count: number }[];
        setErrorResolutions(
          patterns
            .filter((p) => p.resolution)
            .map((p) => ({ fingerprint: p.fingerprint, resolution: p.resolution!, occurrence_count: p.occurrence_count }))
        );
      })
      .catch(() => {});
    // Fetch realm context via attunement
    invoke("assemble_session_context", { sessionId: session.id, tokenBudget: 4000 })
      .then((ctx) => {
        const context = ctx as { realms: { realm_name: string; languages: string[]; frameworks: string[]; architecture_pattern: string | null; conventions: string[] }[] };
        setRealmContexts(context.realms);
      })
      .catch(() => setRealmContexts([]));
  }, [session?.id, session?.working_directory]);

  const bundle: ContextBundle | null = useMemo(() => {
    if (!session) return null;
    return {
      pins,
      memoryFacts: session.metrics.memory_facts,
      recentErrors: session.metrics.recent_errors,
      errorResolutions,
      filesTouched: session.metrics.files_touched,
      workingDirectory: session.working_directory,
      agent: session.detected_agent
        ? `${session.detected_agent.name}${session.detected_agent.model ? ` (${session.detected_agent.model})` : ""}`
        : null,
      realms: realmContexts,
    };
  }, [session, pins, errorResolutions, realmContexts]);

  const formatted = useMemo(() => {
    if (!bundle || !session) return "";
    const lines: string[] = [];
    lines.push(`## Context: ${session.label}`);
    lines.push(`Dir: ${bundle.workingDirectory}${bundle.agent ? ` | Agent: ${bundle.agent}` : ""}`);
    lines.push("");

    if (bundle.realms.length > 0) {
      lines.push("### Projects");
      for (const realm of bundle.realms) {
        lines.push(`- **${realm.realm_name}**: ${realm.languages.join(", ")}${realm.architecture_pattern ? ` (${realm.architecture_pattern})` : ""}`);
        if (realm.frameworks.length > 0) {
          lines.push(`  Frameworks: ${realm.frameworks.join(", ")}`);
        }
        if (realm.conventions.length > 0) {
          lines.push(`  Conventions: ${realm.conventions.slice(0, 5).join(", ")}`);
        }
      }
      lines.push("");
    }

    if (bundle.pins.length > 0) {
      lines.push("### Pinned");
      for (const pin of bundle.pins) {
        lines.push(`- [${pin.kind}] ${pin.label || pin.target}`);
      }
      lines.push("");
    }

    if (bundle.memoryFacts.length > 0) {
      lines.push("### Memory");
      for (const fact of bundle.memoryFacts) {
        lines.push(`- ${fact.key}=${fact.value}`);
      }
      lines.push("");
    }

    if (bundle.errorResolutions.length > 0) {
      lines.push("### Known Errors & Fixes");
      for (const er of bundle.errorResolutions) {
        lines.push(`- "${er.fingerprint}" -> ${er.resolution} (seen ${er.occurrence_count}x)`);
      }
      lines.push("");
    }

    if (bundle.recentErrors.length > 0) {
      lines.push("### Recent Errors");
      for (const err of bundle.recentErrors.slice(-5)) {
        lines.push(`- ${err}`);
      }
      lines.push("");
    }

    if (bundle.filesTouched.length > 0) {
      lines.push(`### Files Touched (${bundle.filesTouched.length})`);
      lines.push(bundle.filesTouched.join(", "));
      lines.push("");
    }

    return lines.join("\n");
  }, [bundle, session]);

  const copyToClipboard = useCallback(async () => {
    if (formatted) {
      await navigator.clipboard.writeText(formatted);
    }
  }, [formatted]);

  return { bundle, formatted, copyToClipboard };
}

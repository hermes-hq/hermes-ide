/**
 * Always-on right Context Panel for agent-mode sessions.
 *
 * Empty shell for v1.0 (M0).  Section content lands in M3 (MCP), M4
 * (Memory), M5 (Permissions); cost expansion + pinned-files content are
 * post-1.0.  Until then, every section renders a placeholder + a
 * `+ Add` CTA so the surface is discoverable.
 *
 * Visual spec: docs/internal/v1-tui-parity-plan.md §8.1.
 * Test contract: docs/internal/v1-tui-parity-plan.md §2 (M0) + §7.2.
 *
 * Props:
 *   `session`        — the active session.  Renders nothing for terminal
 *                      mode or null (cps-1 / cps-2).
 *   `initialState`   — restored width + collapsed map from
 *                      saved_workspace.json (loaded via `loadPanelState`).
 *   `onPersist`      — called whenever width or collapse changes; the
 *                      caller writes the new state to saved_workspace.
 */
import "../styles/components/AgentContextPanel.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  clampPanelWidth,
  DEFAULT_PANEL_WIDTH,
  type PanelSectionKey,
  type PanelState,
} from "../utils/contextPanelLayout";
import { useAgentInit } from "../agent/useAgentInit";
import { useAgentPrewarm } from "../agent/useAgentPrewarm";
import { mergeMcpServers, mergeMemoryPaths } from "../utils/prewarm";
import { McpSection } from "./McpSection";
import { MemorySection } from "./MemorySection";
import { PermissionsSection } from "./PermissionsSection";
import { AddMcpDialog } from "./AddMcpDialog";
import type { PermissionRule } from "../utils/permissionsRules";

interface AgentContextPanelProps {
  session: { id: string; mode: "agent" | "terminal" } | null;
  initialState?: PanelState;
  onPersist?: (state: PanelState) => void;
}

const SECTION_LABELS: Record<PanelSectionKey, string> = {
  mcp: "MCP",
  memory: "MEMORY",
  permissions: "PERMISSIONS",
  pinned: "PINNED FILES",
  cost: "COST & TOKENS",
};

/** Placeholder content per section until M3-M5 land.  Each section
 *  always renders an empty-state CTA (per locked decision §0.6 —
 *  "empty-state CTAs over hidden sections, for discoverability"). */
const SECTION_EMPTY_STATE: Record<PanelSectionKey, { hint: string; cta: string }> = {
  mcp: { hint: "no MCP servers configured", cta: "+ Add MCP server" },
  memory: { hint: "no memory files loaded", cta: "+ Add memory line" },
  permissions: { hint: "no permission rules", cta: "+ Add rule" },
  pinned: { hint: "no pins", cta: "+ Pin file" },
  cost: { hint: "0 turns this session", cta: "+ Set budget" },
};

export function AgentContextPanel({
  session,
  initialState,
  onPersist,
}: AgentContextPanelProps) {
  const [state, setState] = useState<PanelState>(
    () => initialState ?? { width: DEFAULT_PANEL_WIDTH, collapsed: {} },
  );

  // Drag state lives in refs so a 100hz pointermove storm doesn't trigger
  // 100 re-renders.  We rAF-throttle the visual update and fire the
  // single onPersist call on pointerup (cps-13).
  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    nextWidth: number;
    rafId: number | null;
  } | null>(null);

  const persistRef = useRef(onPersist);
  persistRef.current = onPersist;

  const toggleSection = useCallback(
    (key: PanelSectionKey) => {
      setState((prev) => {
        const collapsed = { ...prev.collapsed, [key]: !prev.collapsed[key] };
        const next: PanelState = { ...prev, collapsed };
        persistRef.current?.(next);
        return next;
      });
    },
    [],
  );

  // ─── Resize handle ───────────────────────────────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = {
      startX: e.clientX,
      startWidth: state.width,
      nextWidth: state.width,
      rafId: null,
    };
    document.body.style.cursor = "col-resize";
  }, [state.width]);

  useEffect(() => {
    function onPointerMove(e: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      // Right sidebar: pointer moving LEFT widens the panel, RIGHT narrows it.
      const delta = drag.startX - e.clientX;
      drag.nextWidth = clampPanelWidth(
        drag.startWidth + delta,
        window.innerWidth || 1440,
      );
      if (drag.rafId !== null) return;
      drag.rafId = window.requestAnimationFrame(() => {
        if (!dragRef.current) return;
        setState((prev) => ({ ...prev, width: drag.nextWidth }));
        dragRef.current.rafId = null;
      });
    }
    function onPointerUp() {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.rafId !== null) {
        window.cancelAnimationFrame(drag.rafId);
      }
      // Final commit + persist (single call per drag, per cps-13).
      const final = drag.nextWidth;
      dragRef.current = null;
      document.body.style.cursor = "";
      setState((prev) => {
        const next: PanelState = { ...prev, width: final };
        persistRef.current?.(next);
        return next;
      });
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  // Render-gating: only agent sessions get the panel.
  if (!session || session.mode !== "agent") return null;

  return (
    <aside
      className="agent-context-panel"
      style={{ width: `${state.width}px` }}
      data-testid="agent-context-panel"
    >
      <div
        className="agent-context-panel-resize-handle"
        onPointerDown={onPointerDown}
        role="separator"
        aria-label="Resize Context Panel"
        aria-orientation="vertical"
      />
      <header className="agent-context-panel-header">
        <span className="agent-context-panel-title">HERMES · CONTEXT</span>
      </header>
      <div className="agent-context-panel-body">
        <SectionContent
          sessionId={session.id}
          collapsed={state.collapsed}
          onToggle={toggleSection}
        />
      </div>
    </aside>
  );
}

interface SectionContentProps {
  sessionId: string;
  collapsed: PanelState["collapsed"];
  onToggle: (key: PanelSectionKey) => void;
}

function SectionContent({ sessionId, collapsed, onToggle }: SectionContentProps) {
  const init = useAgentInit(sessionId);
  const prewarm = useAgentPrewarm(init?.cwd);
  const [addingMcp, setAddingMcp] = useState(false);
  const [permRules, setPermRules] = useState<PermissionRule[]>([]);

  // Pull permission rules from settings.json on mount + when init changes
  // (init events fire post-respawn, which is when settings might have been
  // edited externally).
  useEffect(() => {
    let cancelled = false;
    invoke<PermissionRule[]>("read_permission_rules")
      .then((rules) => { if (!cancelled) setPermRules(rules); })
      .catch(() => { if (!cancelled) setPermRules([]); });
    return () => { cancelled = true; };
  }, [init?.session_id]);

  // Static prewarm + live init merge.  Live wins when both available.
  const mcpServers = mergeMcpServers(prewarm.mcpServers, init?.mcp_servers);
  const tools = init?.tools ?? [];
  const memoryPaths = mergeMemoryPaths(prewarm.memoryPaths, init?.memory_paths);
  const existingMcpNames = useMemo(() => mcpServers.map((s) => s.name), [mcpServers]);

  return (
    <>
      <Section
        sectionKey="mcp"
        label={SECTION_LABELS.mcp}
        collapsed={collapsed.mcp ?? false}
        onToggle={() => onToggle("mcp")}
      >
        <McpSection
          servers={mcpServers}
          tools={tools}
          onRequestAdd={() => setAddingMcp(true)}
        />
      </Section>
      <Section
        sectionKey="memory"
        label={SECTION_LABELS.memory}
        collapsed={collapsed.memory ?? false}
        onToggle={() => onToggle("memory")}
      >
        <MemorySection memoryPaths={memoryPaths} />
      </Section>
      <Section
        sectionKey="permissions"
        label={SECTION_LABELS.permissions}
        collapsed={collapsed.permissions ?? false}
        onToggle={() => onToggle("permissions")}
      >
        <PermissionsSection rules={permRules} />
      </Section>
      <Section
        sectionKey="pinned"
        label={SECTION_LABELS.pinned}
        collapsed={collapsed.pinned ?? false}
        onToggle={() => onToggle("pinned")}
      >
        <SectionEmptyState
          hint={SECTION_EMPTY_STATE.pinned.hint}
          cta={SECTION_EMPTY_STATE.pinned.cta}
        />
      </Section>
      <Section
        sectionKey="cost"
        label={SECTION_LABELS.cost}
        collapsed={collapsed.cost ?? false}
        onToggle={() => onToggle("cost")}
      >
        <SectionEmptyState
          hint={SECTION_EMPTY_STATE.cost.hint}
          cta={SECTION_EMPTY_STATE.cost.cta}
        />
      </Section>
      {addingMcp && (
        <AddMcpDialog existingNames={existingMcpNames} onClose={() => setAddingMcp(false)} />
      )}
    </>
  );
}

interface SectionProps {
  sectionKey: PanelSectionKey;
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

function Section({ sectionKey, label, collapsed, onToggle, children }: SectionProps) {
  return (
    <section
      className="agent-context-section"
      data-section={sectionKey}
      data-collapsed={collapsed ? "true" : "false"}
    >
      <button
        type="button"
        className="agent-context-section-header"
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        <span className="agent-context-section-disclosure" aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
        <span className="agent-context-section-header-label">{label}</span>
      </button>
      {!collapsed && <div className="agent-context-section-body">{children}</div>}
    </section>
  );
}

function SectionEmptyState({ hint, cta }: { hint: string; cta: string }) {
  return (
    <div className="agent-context-section-empty">
      <span className="agent-context-empty-hint">{hint}</span>
      <button type="button" className="agent-context-empty-cta">{cta}</button>
    </div>
  );
}

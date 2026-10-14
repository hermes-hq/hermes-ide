// The glyph of each action, shown beside its label and alone when the bar
// is narrow (the label then moves to the tooltip and the accessible name).

import { ChartNoAxesColumn, CircleHelp, Cpu, FileDiff, FilePlus2, Gauge, History, ListChecks, LogIn, Minimize2, Play, Plug, ScanSearch, ShieldCheck, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import type { SessionActionId } from "./catalog";

const SIZE = 14;

export function actionIcon(action: SessionActionId): ReactNode {
  const p = { size: SIZE, "aria-hidden": true, focusable: false } as const;
  switch (action) {
    case "compact": return <Minimize2 {...p} />;
    case "context": return <Gauge {...p} />;
    case "usage": return <ChartNoAxesColumn {...p} />;
    case "model": return <Cpu {...p} />;
    case "plan": return <ListChecks {...p} />;
    case "review": return <ScanSearch {...p} />;
    case "diff": return <FileDiff {...p} />;
    case "rewind": return <Undo2 {...p} />;
    case "resume": return <History {...p} />;
    case "init": return <FilePlus2 {...p} />;
    case "permissions": return <ShieldCheck {...p} />;
    case "mcp": return <Plug {...p} />;
    case "help": return <CircleHelp {...p} />;
    // Destructive actions are never chips: no glyph needed.
    default: return null;
  }
}

export function signInIcon(): ReactNode {
  return <LogIn size={SIZE} aria-hidden focusable={false} />;
}

export function resumeIcon(): ReactNode {
  return <Play size={SIZE} aria-hidden focusable={false} />;
}

/** The Prompts glyph (three lines, as before). */
export function PromptsGlyph() {
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M4 6h16M4 12h16M4 18h9" />
    </svg>
  );
}

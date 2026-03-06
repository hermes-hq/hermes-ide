import { memo } from "react";
import type { MergeStatus, ConflictStrategy } from "../types/git";
import { GitConflictFileRow } from "./GitConflictFileRow";

// ─── Props ───────────────────────────────────────────────────────────

interface GitMergeBannerProps {
  mergeStatus: MergeStatus;
  onResolve: (filePath: string, strategy: ConflictStrategy) => void;
  onViewConflict: (filePath: string) => void;
  onAbort: () => void;
  aborting: boolean;
}

// ─── Pure Helpers (exported for testing) ─────────────────────────────

export function getResolvedCount(mergeStatus: MergeStatus): number {
  return mergeStatus.total_conflicts - mergeStatus.conflicted_files.length;
}

export function allConflictsResolved(mergeStatus: MergeStatus): boolean {
  return mergeStatus.conflicted_files.length === 0 && mergeStatus.in_merge;
}

export interface ConflictSection {
  type: "ours" | "theirs" | "base" | "normal";
  content: string;
  startLine: number;
  endLine: number;
}

export function parseConflictMarkers(content: string): ConflictSection[] {
  const lines = content.split("\n");
  const sections: ConflictSection[] = [];
  let currentType: ConflictSection["type"] = "normal";
  let currentContent: string[] = [];
  let currentStart = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (line.startsWith("<<<<<<< ")) {
      // Flush any accumulated normal content
      if (currentContent.length > 0) {
        sections.push({
          type: currentType,
          content: currentContent.join("\n"),
          startLine: currentStart,
          endLine: lineNum - 1,
        });
        currentContent = [];
      }
      // The marker line itself belongs to "ours" section start
      currentType = "ours";
      currentContent = [line];
      currentStart = lineNum;
    } else if (line.startsWith("||||||| ") && currentType === "ours") {
      // Flush ours section
      if (currentContent.length > 0) {
        sections.push({
          type: "ours",
          content: currentContent.join("\n"),
          startLine: currentStart,
          endLine: lineNum - 1,
        });
        currentContent = [];
      }
      currentType = "base";
      currentContent = [line];
      currentStart = lineNum;
    } else if (line === "=======" && (currentType === "ours" || currentType === "base")) {
      // Flush current section
      if (currentContent.length > 0) {
        sections.push({
          type: currentType,
          content: currentContent.join("\n"),
          startLine: currentStart,
          endLine: lineNum - 1,
        });
        currentContent = [];
      }
      currentType = "theirs";
      currentContent = [line];
      currentStart = lineNum;
    } else if (line.startsWith(">>>>>>> ") && currentType === "theirs") {
      // End theirs section including this marker
      currentContent.push(line);
      sections.push({
        type: "theirs",
        content: currentContent.join("\n"),
        startLine: currentStart,
        endLine: lineNum,
      });
      currentContent = [];
      currentType = "normal";
      currentStart = lineNum + 1;
    } else {
      currentContent.push(line);
    }
  }

  // Flush remaining content
  if (currentContent.length > 0) {
    sections.push({
      type: currentType,
      content: currentContent.join("\n"),
      startLine: currentStart,
      endLine: lines.length,
    });
  }

  return sections;
}

export function countConflictBlocks(content: string): number {
  const matches = content.match(/^<{7} /gm);
  return matches ? matches.length : 0;
}

export function validateMergeMessage(message: string): string | null {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return "Merge message cannot be empty";
  }
  return null;
}

// ─── Component ───────────────────────────────────────────────────────

export const GitMergeBanner = memo(function GitMergeBanner({
  mergeStatus,
  onResolve,
  onViewConflict,
  onAbort,
  aborting,
}: GitMergeBannerProps) {
  if (!mergeStatus.in_merge) return null;

  const resolved = getResolvedCount(mergeStatus);
  const total = mergeStatus.total_conflicts;
  const allDone = allConflictsResolved(mergeStatus);

  return (
    <div className="git-merge-banner">
      <div className="git-merge-banner-icon">{"\u26A0"}</div>
      <div className="git-merge-banner-text">
        <strong>Merge in progress</strong>
        <span className="git-merge-progress">
          <span className={allDone ? "git-merge-progress-done" : ""}>
            {resolved} / {total} resolved
          </span>
        </span>
      </div>
      <button
        className="git-conflict-btn git-conflict-btn-abort"
        onClick={onAbort}
        disabled={aborting}
        title="Abort this merge and return to pre-merge state"
      >
        {aborting ? "Aborting\u2026" : "Abort Merge"}
      </button>

      {/* Conflicted files (unresolved) */}
      {mergeStatus.conflicted_files.length > 0 && (
        <div className="git-conflict-group">
          <div className="git-conflict-group-header">
            Conflicts ({mergeStatus.conflicted_files.length})
          </div>
          {mergeStatus.conflicted_files.map((filePath) => (
            <GitConflictFileRow
              key={filePath}
              filePath={filePath}
              resolved={false}
              onResolve={onResolve}
              onView={onViewConflict}
            />
          ))}
        </div>
      )}

      {/* Resolved files */}
      {mergeStatus.resolved_files.length > 0 && (
        <div className="git-conflict-group">
          <div className="git-conflict-group-header">
            Resolved ({mergeStatus.resolved_files.length})
          </div>
          {mergeStatus.resolved_files.map((filePath) => (
            <GitConflictFileRow
              key={filePath}
              filePath={filePath}
              resolved={true}
              resolvedStrategy="manual"
              onResolve={onResolve}
              onView={onViewConflict}
            />
          ))}
        </div>
      )}
    </div>
  );
});

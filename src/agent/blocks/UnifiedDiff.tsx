import "../../styles/components/agent/AgentSessionView.css";
import { GLYPHS } from "./glyphs";
import { computeDiff, type DiffLine } from "../../utils/unifiedDiff";

interface UnifiedDiffProps {
  before: string;
  after: string;
  /**
   * Optional file path. Currently only used by the truncated banner; reserved
   * for future use (e.g., language hint for a syntax-aware highlighter).
   */
  filePath?: string;
}

/**
 * Phase 4 (v1.0.0 redesign) — UnifiedDiffBlock.
 *
 * Single-column unified diff embedded inside `FileToolBlock` for Edit / Write
 * tool calls. See playbook §5 for the visual grammar (red/green dim
 * backgrounds, `┃` margin glyph, line-number gutter, 3 lines of context).
 */
export function UnifiedDiff({ before, after }: UnifiedDiffProps) {
  const diff = computeDiff(before, after);

  if (diff.truncated) {
    return (
      <div className="agent-diff-truncated">
        Diff too large to render — showing result content only.
      </div>
    );
  }

  return (
    <ol className="agent-diff" role="list">
      {diff.lines.map((line, i) => (
        <DiffRow key={i} line={line} />
      ))}
    </ol>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  if (line.type === "skip") {
    return (
      <li className="agent-diff-skip" aria-hidden="true">
        {"…"}
      </li>
    );
  }
  const oldNum = line.type === "add" ? "" : String(line.oldLine);
  const newNum = line.type === "remove" ? "" : String(line.newLine);
  const marker =
    line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
  const bar = line.type !== "context" ? GLYPHS.margin : "";
  return (
    <li className={`agent-diff-row agent-diff-${line.type}`}>
      <span className="agent-diff-num-old">{oldNum}</span>
      <span className="agent-diff-num-new">{newNum}</span>
      <span className="agent-diff-marker">{marker}</span>
      <span className="agent-diff-bar" aria-hidden="true">
        {bar}
      </span>
      <code className="agent-diff-text">{line.text}</code>
    </li>
  );
}

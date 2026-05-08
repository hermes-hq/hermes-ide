/**
 * PermissionsSection — allow/deny editor for the right Context Panel.
 * Visual: §8.9.
 */
import "../styles/components/PermissionsSection.css";
import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  testPattern,
  type PermissionRule,
  type RuleKind,
  type RuleSource,
} from "../utils/permissionsRules";

interface Props {
  rules: PermissionRule[];
}

export function PermissionsSection({ rules }: Props) {
  const [adding, setAdding] = useState(false);
  const [testInput, setTestInput] = useState("");

  const allow = useMemo(() => rules.filter((r) => r.kind === "allow"), [rules]);
  const deny = useMemo(() => rules.filter((r) => r.kind === "deny"), [rules]);
  const verdict = useMemo(() => testPattern(testInput, rules), [testInput, rules]);

  return (
    <div className="perms-section">
      {rules.length === 0 ? (
        <div className="perms-empty">
          <span className="perms-empty-hint">no permission rules</span>
        </div>
      ) : (
        <>
          <RuleColumn label="allow" rules={allow} />
          <RuleColumn label="deny" rules={deny} />
          <div className="perms-test">
            <input
              type="text"
              className="perms-test-input"
              placeholder="test pattern…"
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
            />
            <span className="perms-test-arrow" aria-hidden="true">→</span>
            <Verdict verdict={verdict} />
          </div>
        </>
      )}
      <button
        type="button"
        className="perms-add-cta"
        onClick={() => setAdding(true)}
      >
        + Add rule
      </button>
      {adding && <AddRuleDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function RuleColumn({ label, rules }: { label: string; rules: PermissionRule[] }) {
  if (rules.length === 0) return null;
  return (
    <div className="perms-column">
      <div className="perms-column-label">{label}</div>
      <ul className="perms-list">
        {rules.map((r) => (
          <li key={`${r.source}:${r.pattern}`} className="perms-row">
            <span className="perms-pattern">{r.pattern}</span>
            <span className="perms-source">{r.source}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Verdict({ verdict }: { verdict: ReturnType<typeof testPattern> }) {
  if (verdict.verdict === "no-match") {
    return <span className="perms-verdict perms-verdict-none">no match</span>;
  }
  return (
    <span
      className={`perms-verdict perms-verdict-${verdict.verdict}`}
      title={`${verdict.pattern} (${verdict.source})`}
    >
      {verdict.verdict} ({verdict.source})
    </span>
  );
}

function AddRuleDialog({ onClose }: { onClose: () => void }) {
  const [pattern, setPattern] = useState("");
  const [kind, setKind] = useState<RuleKind>("allow");
  const [scope, setScope] = useState<RuleSource>("user");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="perms-add-dialog">
      <div className="perms-add-row">
        <label htmlFor="perms-pattern" className="perms-add-label">pattern</label>
        <input
          id="perms-pattern"
          type="text"
          className="perms-add-input"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          autoFocus
        />
      </div>
      <div className="perms-add-row">
        <span className="perms-add-label">kind</span>
        <div className="perms-add-radio-row">
          {(["allow", "deny"] as const).map((k) => (
            <label key={k} className="perms-add-radio">
              <input type="radio" checked={kind === k} onChange={() => setKind(k)} /> {k}
            </label>
          ))}
        </div>
      </div>
      <div className="perms-add-row">
        <span className="perms-add-label">scope</span>
        <div className="perms-add-radio-row">
          {(["user", "project"] as const).map((s) => (
            <label key={s} className="perms-add-radio">
              <input type="radio" checked={scope === s} onChange={() => setScope(s)} /> {s}
            </label>
          ))}
        </div>
      </div>
      {error && <div className="perms-add-error">{error}</div>}
      <div className="perms-add-actions">
        <button type="button" className="perms-link" onClick={onClose}>cancel</button>
        <button
          type="button"
          className="perms-link perms-link-primary"
          disabled={submitting || pattern.trim() === ""}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            try {
              await invoke("write_permission_rule", {
                pattern: pattern.trim(),
                kind,
                scope,
              });
              onClose();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
              setSubmitting(false);
            }
          }}
        >
          save rule
        </button>
      </div>
    </div>
  );
}

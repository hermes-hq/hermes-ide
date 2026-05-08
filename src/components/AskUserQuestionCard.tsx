/**
 * AskUserQuestion slide-up card.
 *
 * Visual: docs/internal/v1-tui-parity-plan.md §8.2.
 *
 * Renders Claude's structured question as a native UI: radio (single)
 * or checkbox (multi) with auto "Other" textarea for freeform answers.
 * Submit composes a `tool_result` envelope that the parent writes to
 * the bridge's stdin via `sendAgentInput`.
 *
 * Composer suppression while this card is mounted is the parent's job
 * (AgentSessionView) — this card just renders + reports.
 */
import "../styles/components/AskUserQuestionCard.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AskAnswer,
  AskUserQuestionInput,
  AskUserQuestionOption,
} from "../utils/askUserQuestion";

const OTHER_LABEL = "Other";

interface Props {
  toolUseId: string;
  input: AskUserQuestionInput;
  onSubmit: (answers: AskAnswer[]) => void;
  onCancel: () => void;
}

interface PerQuestionState {
  selected: string[]; // labels
  otherText: string;
}

export function AskUserQuestionCard({ toolUseId, input, onSubmit, onCancel }: Props) {
  const questions = input.questions;
  const [state, setState] = useState<PerQuestionState[]>(() =>
    questions.map(() => ({ selected: [], otherText: "" })),
  );
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // Degenerate input: empty questions array → nothing to ask, auto-cancel.
  useEffect(() => {
    if (questions.length === 0) onCancelRef.current();
  }, [questions.length]);

  // Esc cancels.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancelRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const focusedOptions = useMemo(
    () => questions.map((_q, i) => state[i]?.selected[0] ?? null).map((label, i) =>
      label ? questions[i].options.find((o) => o.label === label) ?? null : null,
    ),
    [questions, state],
  );

  const submitDisabled = useMemo(() => {
    return questions.some((_q, i) => {
      const s = state[i];
      if (!s) return true;
      if (s.selected.includes(OTHER_LABEL)) {
        return s.otherText.trim() === "";
      }
      return s.selected.length === 0;
    });
  }, [questions, state]);

  if (questions.length === 0) return null;

  function handleSelect(qIndex: number, label: string, multi: boolean) {
    setState((prev) => {
      const next = [...prev];
      const cur = next[qIndex];
      if (multi) {
        const has = cur.selected.includes(label);
        next[qIndex] = {
          ...cur,
          selected: has
            ? cur.selected.filter((l) => l !== label)
            : [...cur.selected, label],
        };
      } else {
        next[qIndex] = { ...cur, selected: [label] };
      }
      return next;
    });
  }

  function handleSubmit() {
    if (submitDisabled) return;
    const answers: AskAnswer[] = questions.map((q, i) => {
      const s = state[i];
      const ans: AskAnswer = { question: q.question, selected: s.selected };
      if (s.selected.includes(OTHER_LABEL) && s.otherText.trim() !== "") {
        ans.notes = s.otherText.trim();
      }
      return ans;
    });
    onSubmit(answers);
  }

  return (
    <div className="aq-card" data-tool-use-id={toolUseId} role="dialog" aria-label="Hermes is waiting for your answer">
      <div className="aq-card-bar" aria-hidden="true" />
      <div className="aq-card-body">
        <div className="aq-card-header">HERMES IS WAITING FOR YOU</div>
        {questions.map((q, qi) => (
          <fieldset key={qi} className="aq-question">
            <legend className="aq-question-legend">{q.header || `Q${qi + 1}`}</legend>
            <div className="aq-question-text">{q.question}</div>
            <div className="aq-question-body">
              <div className="aq-options">
                {q.options.map((opt) => (
                  <OptionRow
                    key={opt.label}
                    qIndex={qi}
                    option={opt}
                    multi={q.multiSelect}
                    selected={state[qi]?.selected.includes(opt.label) ?? false}
                    onSelect={() => handleSelect(qi, opt.label, q.multiSelect)}
                  />
                ))}
                {/* Auto "Other" option */}
                <OtherRow
                  qIndex={qi}
                  multi={q.multiSelect}
                  selected={state[qi]?.selected.includes(OTHER_LABEL) ?? false}
                  text={state[qi]?.otherText ?? ""}
                  onSelect={() => handleSelect(qi, OTHER_LABEL, q.multiSelect)}
                  onTextChange={(value) =>
                    setState((prev) => {
                      const next = [...prev];
                      next[qi] = { ...next[qi], otherText: value };
                      return next;
                    })
                  }
                />
              </div>
              {q.options.some((o) => o.preview) && (
                <PreviewPane option={focusedOptions[qi]} />
              )}
            </div>
          </fieldset>
        ))}
        <div className="aq-actions">
          <button
            type="button"
            className="aq-cancel"
            onClick={() => onCancel()}
          >
            Esc cancel
          </button>
          <button
            type="button"
            className="aq-send"
            onClick={handleSubmit}
            disabled={submitDisabled}
          >
            ⏎ send
          </button>
        </div>
      </div>
    </div>
  );
}

function OptionRow({
  qIndex,
  option,
  multi,
  selected,
  onSelect,
}: {
  qIndex: number;
  option: AskUserQuestionOption;
  multi: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const id = `aq-q${qIndex}-${option.label}`;
  return (
    <label className="aq-option-row" data-selected={selected}>
      <input
        id={id}
        type={multi ? "checkbox" : "radio"}
        name={`aq-q${qIndex}`}
        checked={selected}
        onChange={onSelect}
        className="aq-option-input"
      />
      <span className="aq-option-glyph" aria-hidden="true">
        {selected ? (multi ? "☑" : "◉") : (multi ? "☐" : "○")}
      </span>
      <span className="aq-option-text">
        <span className="aq-option-label">{option.label}</span>
        {option.description && (
          <span className="aq-option-description">{option.description}</span>
        )}
      </span>
    </label>
  );
}

function OtherRow({
  qIndex,
  multi,
  selected,
  text,
  onSelect,
  onTextChange,
}: {
  qIndex: number;
  multi: boolean;
  selected: boolean;
  text: string;
  onSelect: () => void;
  onTextChange: (v: string) => void;
}) {
  return (
    <label className="aq-option-row aq-option-row-other" data-selected={selected}>
      <input
        type={multi ? "checkbox" : "radio"}
        name={`aq-q${qIndex}`}
        checked={selected}
        onChange={onSelect}
        className="aq-option-input"
      />
      <span className="aq-option-glyph" aria-hidden="true">
        {selected ? (multi ? "☑" : "◉") : (multi ? "☐" : "○")}
      </span>
      <span className="aq-option-text">
        <span className="aq-option-label">{OTHER_LABEL}</span>
        {selected && (
          <textarea
            className="aq-other-textarea"
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            placeholder="type a custom answer…"
            rows={2}
            autoFocus
          />
        )}
      </span>
    </label>
  );
}

function PreviewPane({ option }: { option: AskUserQuestionOption | null }) {
  return (
    <div className="aq-preview-pane" data-testid="aq-preview-pane">
      {option?.preview ? (
        <pre className="aq-preview-content">{option.preview}</pre>
      ) : (
        <span className="aq-preview-empty">focus an option to preview</span>
      )}
    </div>
  );
}

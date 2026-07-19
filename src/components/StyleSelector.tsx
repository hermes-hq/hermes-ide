import "../styles/components/StyleSelector.css";
import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import type { StyleDefinition, SelectedStyle } from "../lib/styles";
import { validateCustomStyle } from "../lib/styles";
import { useI18n } from "../i18n/I18nProvider";

interface StyleSelectorProps {
  selections: SelectedStyle[];
  allStyles: StyleDefinition[];
  onChange: (selections: SelectedStyle[]) => void;
  onCreateCustom: (style: Omit<StyleDefinition, "id" | "builtIn">) => void;
  onDeleteCustom: (id: string) => void;
}

function LevelDots({
  level,
  onChange,
}: {
  level: number;
  onChange: (level: number) => void;
}) {
  const { t } = useI18n();
  return (
    <span className="style-selector-dots" title={t("builder.intensityLevel", { level })}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          className={`style-selector-dot${n <= level ? " style-selector-dot-filled" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onChange(n);
          }}
          title={t("builder.levelDot", { level: n })}
        />
      ))}
    </span>
  );
}

export function StyleSelector({
  selections,
  allStyles,
  onChange,
  onCreateCustom,
  onDeleteCustom,
}: StyleSelectorProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newLevels, setNewLevels] = useState<[string, string, string, string, string]>(["", "", "", "", ""]);
  const [createError, setCreateError] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  // Position the fixed dropdown relative to the search input
  useLayoutEffect(() => {
    if (!open || !inputRef.current) return;
    const rect = inputRef.current.getBoundingClientRect();
    const maxH = 240;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const top = spaceBelow >= maxH ? rect.bottom + 2 : Math.max(8, rect.top - maxH - 2);
    setDropdownStyle({
      top: `${top}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
    });
  }, [open, query]);

  const selectedIds = new Set(selections.map((s) => s.id));

  const filtered = allStyles.filter((s) => {
    const q = query.toLowerCase();
    if (!q) return true;
    return (
      s.label.toLowerCase().includes(q) ||
      (s.description || "").toLowerCase().includes(q)
    );
  });

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setShowCreateForm(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => { setHighlightIdx(0); }, [query]);

  useEffect(() => {
    if (!open || !dropdownRef.current) return;
    const item = dropdownRef.current.querySelector(".style-selector-item-active");
    if (item) item.scrollIntoView({ block: "nearest" });
  }, [highlightIdx, open]);

  const toggleStyle = useCallback(
    (id: string) => {
      if (selectedIds.has(id)) {
        onChange(selections.filter((s) => s.id !== id));
      } else {
        onChange([...selections, { id, level: 3 }]);
      }
    },
    [selections, selectedIds, onChange],
  );

  const updateLevel = useCallback(
    (id: string, level: number) => {
      onChange(selections.map((s) => (s.id === id ? { ...s, level } : s)));
    },
    [selections, onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }
        return;
      }

      e.stopPropagation();

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[highlightIdx]) {
          toggleStyle(filtered[highlightIdx].id);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        setQuery("");
      }
    },
    [open, filtered, highlightIdx, toggleStyle],
  );

  const handleCreate = useCallback(() => {
    const result = validateCustomStyle(
      { label: newLabel, description: newDescription || undefined, levels: newLevels },
      allStyles,
    );
    if (!result.valid) {
      setCreateError(result.error || t("builder.invalidStyle"));
      return;
    }
    onCreateCustom({
      label: newLabel.trim(),
      description: newDescription.trim() || undefined,
      levels: newLevels.map((l) => l.trim()) as [string, string, string, string, string],
    });
    setNewLabel("");
    setNewDescription("");
    setNewLevels(["", "", "", "", ""]);
    setCreateError("");
    setShowCreateForm(false);
  }, [newLabel, newDescription, newLevels, allStyles, onCreateCustom, t]);

  const selectedStyles = selections
    .map((sel) => {
      const def = allStyles.find((s) => s.id === sel.id);
      return def ? { ...def, level: sel.level } : null;
    })
    .filter((s): s is StyleDefinition & { level: number } => s !== null);

  return (
    <div className="style-selector" ref={wrapperRef}>
      <label className="prompt-composer-field-label">{t("builder.style")}</label>

      {/* Selected pills with level dots */}
      {selectedStyles.length > 0 && (
        <div className="style-selector-pills">
          {selectedStyles.map((style) => (
            <span key={style.id} className="style-selector-pill">
              <span className="style-selector-pill-label">{style.label}</span>
              <LevelDots
                level={style.level}
                onChange={(lvl) => updateLevel(style.id, lvl)}
              />
              <button
                className="style-selector-pill-remove"
                onClick={() => toggleStyle(style.id)}
                title={t("builder.removeStyle")}
              >
                x
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Search input */}
      <input
        ref={inputRef}
        className="style-selector-search"
        placeholder={selections.length ? t("builder.stylesSelectedPlaceholder", { count: selections.length }) : t("builder.searchStyles")}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
      />

      {/* Dropdown */}
      {open && !showCreateForm && (
        <div className="style-selector-dropdown" ref={dropdownRef} style={dropdownStyle}>
          {filtered.map((style, idx) => {
            const sel = selections.find((s) => s.id === style.id);
            const isSelected = !!sel;
            return (
              <div
                key={style.id}
                className={`style-selector-item${idx === highlightIdx ? " style-selector-item-active" : ""}`}
                onMouseEnter={() => setHighlightIdx(idx)}
                onClick={() => toggleStyle(style.id)}
              >
                <span className="style-selector-item-check">
                  {isSelected ? "[x]" : "[ ]"}
                </span>
                <div className="style-selector-item-info">
                  <span className="style-selector-item-label">{style.label}</span>
                  {style.description && (
                    <span className="style-selector-item-desc">{style.description}</span>
                  )}
                </div>
                {!style.builtIn && (
                  <button
                    className="style-selector-item-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteCustom(style.id);
                    }}
                    title={t("builder.deleteCustomStyle")}
                  >
                    x
                  </button>
                )}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="style-selector-item style-selector-empty">{t("builder.noStylesMatch", { query })}</div>
          )}
          <button
            className="style-selector-create-btn"
            onClick={() => setShowCreateForm(true)}
          >
            + {t("builder.createCustomStyle")}
          </button>
        </div>
      )}

      {/* Create form */}
      {showCreateForm && (
        <div className="style-selector-dropdown">
          <div className="style-selector-create-form">
            <div className="style-selector-create-field">
              <label>{t("builder.label")}</label>
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder={t("builder.styleLabelPlaceholder")}
                autoFocus
              />
            </div>
            <div className="style-selector-create-field">
              <label>{t("builder.descriptionOptional")}</label>
              <input
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder={t("builder.styleDescriptionPlaceholder")}
              />
            </div>
            {[1, 2, 3, 4, 5].map((lvl) => (
              <div key={lvl} className="style-selector-create-field">
                <label>
                  {t("builder.levelInstruction", { level: lvl })}
                  <span className="style-selector-create-dots">
                    {Array.from({ length: 5 }, (_, i) => (
                      <span key={i} className={`style-selector-dot-preview${i < lvl ? " style-selector-dot-preview-filled" : ""}`} />
                    ))}
                  </span>
                </label>
                <input
                  value={newLevels[lvl - 1]}
                  onChange={(e) => {
                    const updated = [...newLevels] as [string, string, string, string, string];
                    updated[lvl - 1] = e.target.value;
                    setNewLevels(updated);
                  }}
                  placeholder={
                    lvl === 1 ? t("builder.subtleVersion")
                    : lvl === 3 ? t("builder.standardVersion")
                    : lvl === 5 ? t("builder.maximumIntensity")
                    : ""
                  }
                />
              </div>
            ))}
            {createError && <div className="style-selector-create-error">{createError}</div>}
            <div className="style-selector-create-actions">
              <button className="prompt-composer-btn prompt-composer-btn-sm" onClick={handleCreate}>
                {t("builder.save")}
              </button>
              <button
                className="prompt-composer-btn prompt-composer-btn-sm"
                onClick={() => {
                  setShowCreateForm(false);
                  setCreateError("");
                }}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

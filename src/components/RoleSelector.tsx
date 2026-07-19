import "../styles/components/RoleSelector.css";
import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import type { RoleDefinition } from "../lib/roles";
import { validateCustomRole } from "../lib/roles";
import { useI18n } from "../i18n/I18nProvider";

interface RoleSelectorProps {
  selectedIds: string[];
  allRoles: RoleDefinition[];
  onChange: (ids: string[]) => void;
  onCreateCustom: (role: Omit<RoleDefinition, "id" | "builtIn">) => void;
  onDeleteCustom: (id: string) => void;
}

export function RoleSelector({
  selectedIds,
  allRoles,
  onChange,
  onCreateCustom,
  onDeleteCustom,
}: RoleSelectorProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newInstruction, setNewInstruction] = useState("");
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

  const filtered = allRoles.filter((r) => {
    const q = query.toLowerCase();
    if (!q) return true;
    return (
      r.label.toLowerCase().includes(q) ||
      (r.description || "").toLowerCase().includes(q)
    );
  });

  // Close dropdown on outside click
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

  // Reset highlight when filter changes
  useEffect(() => {
    setHighlightIdx(0);
  }, [query]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!open || !dropdownRef.current) return;
    const item = dropdownRef.current.querySelector(".role-selector-item-active");
    if (item) item.scrollIntoView({ block: "nearest" });
  }, [highlightIdx, open]);

  const toggleRole = useCallback(
    (id: string) => {
      if (selectedIds.includes(id)) {
        onChange(selectedIds.filter((rid) => rid !== id));
      } else {
        onChange([...selectedIds, id]);
      }
    },
    [selectedIds, onChange],
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
          toggleRole(filtered[highlightIdx].id);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        setQuery("");
      }
    },
    [open, filtered, highlightIdx, toggleRole],
  );

  const handleCreate = useCallback(() => {
    const result = validateCustomRole(
      { label: newLabel, description: newDescription || undefined, systemInstruction: newInstruction },
      allRoles,
    );
    if (!result.valid) {
      setCreateError(result.error || t("builder.invalidRole"));
      return;
    }
    onCreateCustom({
      label: newLabel.trim(),
      description: newDescription.trim() || undefined,
      systemInstruction: newInstruction.trim(),
    });
    setNewLabel("");
    setNewDescription("");
    setNewInstruction("");
    setCreateError("");
    setShowCreateForm(false);
  }, [newLabel, newDescription, newInstruction, allRoles, onCreateCustom, t]);

  const selectedRoles = selectedIds
    .map((id) => allRoles.find((r) => r.id === id))
    .filter((r): r is RoleDefinition => r !== undefined);

  return (
    <div className="role-selector" ref={wrapperRef}>
      <label className="prompt-composer-field-label">{t("builder.roles")}</label>

      {/* Selected pills */}
      {selectedRoles.length > 0 && (
        <div className="role-selector-pills">
          {selectedRoles.map((role) => (
            <span key={role.id} className="role-selector-pill">
              <span className="role-selector-pill-label">{role.label}</span>
              <button
                className="role-selector-pill-remove"
                onClick={() => toggleRole(role.id)}
                title={t("builder.removeRole")}
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
        className="role-selector-search"
        placeholder={selectedIds.length ? t("builder.rolesSelectedPlaceholder", { count: selectedIds.length }) : t("builder.searchRoles")}
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
        <div className="role-selector-dropdown" ref={dropdownRef} style={dropdownStyle}>
          {filtered.map((role, idx) => (
            <div
              key={role.id}
              className={`role-selector-item${idx === highlightIdx ? " role-selector-item-active" : ""}`}
              onMouseEnter={() => setHighlightIdx(idx)}
              onClick={() => toggleRole(role.id)}
            >
              <span className="role-selector-item-check">
                {selectedIds.includes(role.id) ? "[x]" : "[ ]"}
              </span>
              <div className="role-selector-item-info">
                <span className="role-selector-item-label">{role.label}</span>
                {role.description && (
                  <span className="role-selector-item-desc">{role.description}</span>
                )}
              </div>
              {!role.builtIn && (
                <button
                  className="role-selector-item-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteCustom(role.id);
                  }}
                  title={t("builder.deleteCustomRole")}
                >
                  x
                </button>
              )}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="role-selector-item role-selector-empty">{t("builder.noRolesMatch", { query })}</div>
          )}
          <button
            className="role-selector-create-btn"
            onClick={() => setShowCreateForm(true)}
          >
            + {t("builder.createCustomRole")}
          </button>
        </div>
      )}

      {/* Create form */}
      {showCreateForm && (
        <div className="role-selector-dropdown">
          <div className="role-selector-create-form">
            <div className="role-selector-create-field">
              <label>{t("builder.label")}</label>
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder={t("builder.roleLabelPlaceholder")}
                autoFocus
              />
            </div>
            <div className="role-selector-create-field">
              <label>{t("builder.descriptionOptional")}</label>
              <input
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder={t("builder.roleDescriptionPlaceholder")}
              />
            </div>
            <div className="role-selector-create-field">
              <label>{t("builder.systemInstruction")}</label>
              <textarea
                value={newInstruction}
                onChange={(e) => setNewInstruction(e.target.value)}
                placeholder={t("builder.systemInstructionPlaceholder")}
                rows={3}
              />
            </div>
            {createError && <div className="role-selector-create-error">{createError}</div>}
            <div className="role-selector-create-actions">
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

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { getSetting, setSetting } from "../api/settings";
import { writeToSession } from "../api/sessions";
import {
  ComposerFields,
  EMPTY_FIELDS,
  BUILT_IN_TEMPLATES,
  BUILT_IN_ROLES,
  BUILT_IN_STYLES,
  compilePrompt,
} from "../lib/compilePrompt";
import type { PromptTemplate } from "../lib/templates";
import type { RoleDefinition } from "../lib/roles";
import type { StyleDefinition, SelectedStyle } from "../lib/styles";
import { RoleSelector } from "./RoleSelector";
import { StyleSelector } from "./StyleSelector";
import { TemplatePicker } from "./TemplatePicker";

interface PromptComposerProps {
  sessionId: string;
  onClose: () => void;
}

const FIELD_META: { key: "task" | "scope"; label: string; placeholder: string; rows: number }[] = [
  { key: "task", label: "Task", placeholder: "What should the AI do? This is the main instruction.", rows: 4 },
  { key: "scope", label: "Scope", placeholder: "Files, directories, or boundaries. e.g. Focus on src/auth/. Don't touch tests.", rows: 2 },
];

/**
 * Migrate a v1/v2 saved template to v3 format (with recommendedStyles).
 */
function migrateTemplate(tpl: Record<string, unknown>): PromptTemplate {
  const fields = (tpl.fields || {}) as Record<string, unknown>;
  const hasLegacyRole = typeof fields.role === "string" && !Array.isArray(fields.roleIds);

  if (hasLegacyRole) {
    // v1 template — convert string role to empty roleIds, prepend old role to constraints
    const oldRole = fields.role as string;
    const oldConstraints = (fields.constraints as string) || "";
    const migratedConstraints = oldRole
      ? oldRole + (oldConstraints ? "\n" + oldConstraints : "")
      : oldConstraints;
    return {
      id: tpl.id as string,
      name: tpl.name as string,
      category: "documentation" as const,
      recommendedRoles: [],
      recommendedStyles: [],
      builtIn: false,
      fields: {
        roleIds: [],
        task: (fields.task as string) || "",
        scope: (fields.scope as string) || "",
        constraints: migratedConstraints,
        styleSelections: [],
        style: (fields.style as string) || "",
      },
    };
  }

  // Ensure recommendedStyles exists (v2 → v3 migration)
  const result = tpl as unknown as PromptTemplate;
  if (!result.recommendedStyles) {
    result.recommendedStyles = [];
  }
  return result;
}

export function PromptComposer({ sessionId, onClose }: PromptComposerProps) {
  const [fields, setFields] = useState<ComposerFields>({ ...EMPTY_FIELDS });
  const [userTemplates, setUserTemplates] = useState<PromptTemplate[]>([]);
  const [customRoles, setCustomRoles] = useState<RoleDefinition[]>([]);
  const [customStyles, setCustomStyles] = useState<StyleDefinition[]>([]);
  const [saveTemplateName, setSaveTemplateName] = useState("");
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const saveInputRef = useRef<HTMLInputElement>(null);

  const allRoles = useMemo(() => [...BUILT_IN_ROLES, ...customRoles], [customRoles]);
  const allStyles = useMemo(() => [...BUILT_IN_STYLES, ...customStyles], [customStyles]);

  // Load user templates on mount
  useEffect(() => {
    getSetting("prompt_templates")
      .then((val) => {
        if (typeof val === "string" && val) {
          try {
            const parsed = JSON.parse(val) as Record<string, unknown>[];
            setUserTemplates(parsed.map(migrateTemplate));
          } catch { /* ignore malformed JSON */ }
        }
      })
      .catch((err) => console.warn("[PromptComposer] Failed to load templates:", err));
  }, []);

  // Load custom roles on mount
  useEffect(() => {
    getSetting("custom_roles")
      .then((val) => {
        if (typeof val === "string" && val) {
          try { setCustomRoles(JSON.parse(val)); } catch { /* ignore malformed JSON */ }
        }
      })
      .catch((err) => console.warn("[PromptComposer] Failed to load custom roles:", err));
  }, []);

  // Load custom styles on mount
  useEffect(() => {
    getSetting("custom_styles")
      .then((val) => {
        if (typeof val === "string" && val) {
          try { setCustomStyles(JSON.parse(val)); } catch { /* ignore malformed JSON */ }
        }
      })
      .catch((err) => console.warn("[PromptComposer] Failed to load custom styles:", err));
  }, []);

  // Focus task field on mount
  useEffect(() => { taskRef.current?.focus(); }, []);

  // Focus save input when shown
  useEffect(() => {
    if (showSaveInput) saveInputRef.current?.focus();
  }, [showSaveInput]);

  // Open advanced if constraints or free-text style have content
  useEffect(() => {
    if (fields.constraints.trim() || fields.style.trim()) {
      setAdvancedOpen(true);
    }
  }, []); // only on mount

  const compiled = useMemo(
    () => compilePrompt(fields, allRoles, allStyles),
    [fields, allRoles, allStyles],
  );

  const updateField = useCallback((key: keyof ComposerFields, value: string | string[] | SelectedStyle[]) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  }, []);

  const applyTemplate = useCallback((tpl: PromptTemplate) => {
    const newFields: ComposerFields = {
      ...EMPTY_FIELDS,
      ...tpl.fields,
      roleIds: tpl.recommendedRoles || [],
      styleSelections: tpl.recommendedStyles || [],
    };
    setFields(newFields);
    // Open advanced if template has constraints or free-text style
    if ((tpl.fields.constraints || "").trim() || (tpl.fields.style || "").trim()) {
      setAdvancedOpen(true);
    }
  }, []);

  const sendPrompt = useCallback(() => {
    if (!compiled.trim()) return;
    // Wrap in bracketed paste so CLIs treat multi-line content as a single paste,
    // then append \r to submit. Use TextEncoder for proper UTF-8 base64 encoding.
    const payload = "\x1b[200~" + compiled + "\x1b[201~" + "\r";
    const bytes = new TextEncoder().encode(payload);
    const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    const data = btoa(binary);
    writeToSession(sessionId, data).catch(console.error);
    onClose();
  }, [compiled, sessionId, onClose]);

  const copyPrompt = useCallback(() => {
    if (!compiled.trim()) return;
    navigator.clipboard.writeText(compiled).catch(console.error);
  }, [compiled]);

  const saveTemplate = useCallback(() => {
    const name = saveTemplateName.trim();
    if (!name) return;
    const id = `user-${Date.now()}`;
    const newTemplate: PromptTemplate = {
      id,
      name,
      category: "documentation",
      recommendedRoles: fields.roleIds,
      recommendedStyles: fields.styleSelections,
      builtIn: false,
      fields: { ...fields },
    };
    const updated = [...userTemplates.filter((t) => t.name !== name), newTemplate];
    setUserTemplates(updated);
    setSetting("prompt_templates", JSON.stringify(updated)).catch(console.error);
    setSaveTemplateName("");
    setShowSaveInput(false);
  }, [saveTemplateName, fields, userTemplates]);

  const deleteTemplate = useCallback((id: string) => {
    const updated = userTemplates.filter((t) => t.id !== id);
    setUserTemplates(updated);
    setSetting("prompt_templates", JSON.stringify(updated)).catch(console.error);
  }, [userTemplates]);

  const createCustomRole = useCallback((role: Omit<RoleDefinition, "id" | "builtIn">) => {
    const newRole: RoleDefinition = {
      ...role,
      id: `custom-${Date.now()}`,
      builtIn: false,
    };
    const updated = [...customRoles, newRole];
    setCustomRoles(updated);
    setSetting("custom_roles", JSON.stringify(updated)).catch(console.error);
    setFields((prev) => ({ ...prev, roleIds: [...prev.roleIds, newRole.id] }));
  }, [customRoles]);

  const deleteCustomRole = useCallback((id: string) => {
    const updated = customRoles.filter((r) => r.id !== id);
    setCustomRoles(updated);
    setSetting("custom_roles", JSON.stringify(updated)).catch(console.error);
    setFields((prev) => ({ ...prev, roleIds: prev.roleIds.filter((rid) => rid !== id) }));
  }, [customRoles]);

  const createCustomStyle = useCallback((style: Omit<StyleDefinition, "id" | "builtIn">) => {
    const newStyle: StyleDefinition = {
      ...style,
      id: `custom-style-${Date.now()}`,
      builtIn: false,
    };
    const updated = [...customStyles, newStyle];
    setCustomStyles(updated);
    setSetting("custom_styles", JSON.stringify(updated)).catch(console.error);
    setFields((prev) => ({
      ...prev,
      styleSelections: [...prev.styleSelections, { id: newStyle.id, level: 3 }],
    }));
  }, [customStyles]);

  const deleteCustomStyle = useCallback((id: string) => {
    const updated = customStyles.filter((s) => s.id !== id);
    setCustomStyles(updated);
    setSetting("custom_styles", JSON.stringify(updated)).catch(console.error);
    setFields((prev) => ({
      ...prev,
      styleSelections: prev.styleSelections.filter((s) => s.id !== id),
    }));
  }, [customStyles]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      sendPrompt();
    }
  }, [onClose, sendPrompt]);

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="prompt-composer" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        {/* Header */}
        <div className="prompt-composer-header">
          <span className="prompt-composer-title">Prompt Composer</span>
          <div className="prompt-composer-header-right">
            <TemplatePicker
              builtInTemplates={BUILT_IN_TEMPLATES}
              userTemplates={userTemplates}
              onSelect={applyTemplate}
              onDeleteUser={deleteTemplate}
            />
            <button className="prompt-composer-close" onClick={onClose} title="Close (Esc)">&#10005;</button>
          </div>
        </div>

        {/* Body: fields + preview */}
        <div className="prompt-composer-body">
          <div className="prompt-composer-fields">
            {/* Role Selector */}
            <RoleSelector
              selectedIds={fields.roleIds}
              allRoles={allRoles}
              onChange={(ids) => updateField("roleIds", ids)}
              onCreateCustom={createCustomRole}
              onDeleteCustom={deleteCustomRole}
            />

            {/* Style Selector */}
            <StyleSelector
              selections={fields.styleSelections}
              allStyles={allStyles}
              onChange={(sels) => updateField("styleSelections", sels)}
              onCreateCustom={createCustomStyle}
              onDeleteCustom={deleteCustomStyle}
            />

            {/* Task + Scope */}
            {FIELD_META.map(({ key, label, placeholder, rows }) => (
              <div key={key} className="prompt-composer-field">
                <label>{label}</label>
                <textarea
                  ref={key === "task" ? taskRef : undefined}
                  rows={rows}
                  placeholder={placeholder}
                  value={fields[key]}
                  onChange={(e) => updateField(key, e.target.value)}
                />
              </div>
            ))}

            {/* Advanced toggle */}
            <button
              className="prompt-composer-advanced-toggle"
              onClick={() => setAdvancedOpen(!advancedOpen)}
            >
              <span className="prompt-composer-advanced-chevron">
                {advancedOpen ? "\u25be" : "\u25b8"}
              </span>
              Advanced
            </button>
            {advancedOpen && (
              <div className="prompt-composer-advanced-body">
                <div className="prompt-composer-field">
                  <label>Constraints</label>
                  <textarea
                    rows={2}
                    placeholder="Rules, limitations, requirements. e.g. No new dependencies. Keep backward compat."
                    value={fields.constraints}
                    onChange={(e) => updateField("constraints", e.target.value)}
                  />
                </div>
                <div className="prompt-composer-field">
                  <label>Additional Style Notes</label>
                  <textarea
                    rows={2}
                    placeholder="Extra style instructions beyond the presets above. e.g. Show line references."
                    value={fields.style}
                    onChange={(e) => updateField("style", e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>
          <div className="prompt-composer-preview">
            <div className="prompt-composer-preview-label">Preview</div>
            <pre className="prompt-composer-preview-content">
              {compiled || "Fill in the fields to see the compiled prompt..."}
            </pre>
          </div>
        </div>

        {/* Actions */}
        <div className="prompt-composer-actions">
          <div className="prompt-composer-actions-left">
            {showSaveInput ? (
              <div className="prompt-composer-save-row">
                <input
                  ref={saveInputRef}
                  className="prompt-composer-save-input"
                  placeholder="Template name..."
                  value={saveTemplateName}
                  onChange={(e) => setSaveTemplateName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.stopPropagation(); saveTemplate(); }
                    if (e.key === "Escape") { e.stopPropagation(); setShowSaveInput(false); }
                  }}
                />
                <button className="prompt-composer-btn prompt-composer-btn-sm" onClick={saveTemplate}>Save</button>
                <button className="prompt-composer-btn prompt-composer-btn-sm" onClick={() => setShowSaveInput(false)}>Cancel</button>
              </div>
            ) : (
              <button className="prompt-composer-btn" onClick={() => setShowSaveInput(true)}>Save Template</button>
            )}
          </div>
          <div className="prompt-composer-actions-right">
            <button className="prompt-composer-btn" onClick={copyPrompt} disabled={!compiled.trim()}>Copy</button>
            <button className="prompt-composer-btn prompt-composer-btn-send" onClick={sendPrompt} disabled={!compiled.trim()}>
              Send <kbd>&#8984;&#8629;</kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

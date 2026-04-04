import "../styles/components/PromptComposer.css";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useTextContextMenu } from "../hooks/useTextContextMenu";
import { fmt, isActionMod } from "../utils/platform";
import { getSetting, setSetting } from "../api/settings";
import { exportPromptBundle, importPromptBundle } from "../api/promptBundle";
import { writeToSession } from "../api/sessions";
import { save, open } from "@tauri-apps/plugin-dialog";
import { createBundle, validateBundle, importBundle } from "../lib/promptBundle";
import { dismissSuggestions, clearGhostText, getInputBufferLength, clearInputBuffer } from "../terminal/TerminalPool";
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
  addToast?: (toast: { message: string; type: "info" | "success" | "warning" | "error"; duration: number }) => void;
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

export function PromptComposer({ sessionId, onClose, addToast }: PromptComposerProps) {
  const [fields, setFields] = useState<ComposerFields>({ ...EMPTY_FIELDS });
  const [userTemplates, setUserTemplates] = useState<PromptTemplate[]>([]);
  const [customRoles, setCustomRoles] = useState<RoleDefinition[]>([]);
  const [customStyles, setCustomStyles] = useState<StyleDefinition[]>([]);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [saveTemplateName, setSaveTemplateName] = useState("");
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const saveInputRef = useRef<HTMLInputElement>(null);
  const { onContextMenu: textContextMenu } = useTextContextMenu();

  const toggleTemplatePicker = useCallback(() => {
    setTemplatePickerOpen((prev) => !prev);
  }, []);

  const clearFields = useCallback(() => {
    setFields({ ...EMPTY_FIELDS });
    setAdvancedOpen(false);
    setConfirmingClear(false);
    taskRef.current?.focus();
  }, []);

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

  // Load pinned templates on mount
  useEffect(() => {
    getSetting("pinned_templates")
      .then((val) => {
        if (typeof val === "string" && val) {
          try { setPinnedIds(new Set(JSON.parse(val))); } catch { /* ignore malformed JSON */ }
        }
      })
      .catch((err) => console.warn("[PromptComposer] Failed to load pinned templates:", err));
  }, []);

  // Load template groups on mount
  const [templateGroups, setTemplateGroups] = useState<string[]>([]);
  useEffect(() => {
    getSetting("template_groups")
      .then((val) => {
        if (typeof val === "string" && val) {
          try { setTemplateGroups(JSON.parse(val)); } catch { /* ignore malformed JSON */ }
        }
      })
      .catch((err) => console.warn("[PromptComposer] Failed to load template groups:", err));
  }, []);

  const createGroup = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed || templateGroups.includes(trimmed)) return;
    const updated = [...templateGroups, trimmed];
    setTemplateGroups(updated);
    setSetting("template_groups", JSON.stringify(updated)).catch(console.error);
  }, [templateGroups]);

  const renameGroup = useCallback((oldName: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || (trimmed !== oldName && templateGroups.includes(trimmed))) return;
    const updatedGroups = templateGroups.map(g => g === oldName ? trimmed : g);
    setTemplateGroups(updatedGroups);
    setSetting("template_groups", JSON.stringify(updatedGroups)).catch(console.error);
    const updatedTemplates = userTemplates.map(t =>
      t.group === oldName ? { ...t, group: trimmed } : t
    );
    setUserTemplates(updatedTemplates);
    setSetting("prompt_templates", JSON.stringify(updatedTemplates)).catch(console.error);
  }, [templateGroups, userTemplates]);

  const deleteGroup = useCallback((name: string) => {
    const updatedGroups = templateGroups.filter(g => g !== name);
    setTemplateGroups(updatedGroups);
    setSetting("template_groups", JSON.stringify(updatedGroups)).catch(console.error);
    const updatedTemplates = userTemplates.map(t =>
      t.group === name ? { ...t, group: undefined } : t
    );
    setUserTemplates(updatedTemplates);
    setSetting("prompt_templates", JSON.stringify(updatedTemplates)).catch(console.error);
  }, [templateGroups, userTemplates]);

  const moveToGroup = useCallback((templateId: string, group: string | null) => {
    const updatedTemplates = userTemplates.map(t =>
      t.id === templateId ? { ...t, group: group ?? undefined } : t
    );
    setUserTemplates(updatedTemplates);
    setSetting("prompt_templates", JSON.stringify(updatedTemplates)).catch(console.error);
  }, [userTemplates]);

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
      // For user-saved templates, prefer the saved fields (roleIds/styleSelections)
      // over the recommended* arrays. For built-in templates (which don't store
      // roleIds/styleSelections in fields), use the recommended* arrays.
      roleIds: (tpl.fields.roleIds && tpl.fields.roleIds.length > 0)
        ? tpl.fields.roleIds
        : (tpl.recommendedRoles || []),
      styleSelections: (tpl.fields.styleSelections && tpl.fields.styleSelections.length > 0)
        ? tpl.fields.styleSelections
        : (tpl.recommendedStyles || []),
    };
    setFields(newFields);
    // Open advanced if template has constraints or free-text style
    if ((tpl.fields.constraints || "").trim() || (tpl.fields.style || "").trim()) {
      setAdvancedOpen(true);
    }
  }, []);

  const sendPrompt = useCallback(async () => {
    if (!compiled.trim()) return;
    // Clear any active terminal intelligence state so it doesn't interfere
    // with the submitted prompt (e.g. ghost text or suggestion overlay executing on focus)
    dismissSuggestions(sessionId);
    clearGhostText(sessionId);
    // Erase any existing terminal input (same pattern as sendShortcutCommand) so
    // the CLI's current line and ghost text are cleared before the composed prompt.
    const eraseLen = getInputBufferLength(sessionId);
    clearInputBuffer(sessionId);
    const backspaces = eraseLen > 0 ? "\x7f".repeat(eraseLen) : "";
    // Wrap in bracketed paste so CLIs treat multi-line content as a single paste,
    // then append \r to submit. Use TextEncoder for proper UTF-8 base64 encoding.
    const payload = backspaces + "\x1b[200~" + compiled + "\x1b[201~" + "\r";
    const bytes = new TextEncoder().encode(payload);
    const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    const data = btoa(binary);
    // IMPORTANT: await the write so the composed prompt reaches the PTY BEFORE
    // the Prompt Composer closes. Closing first can cause focus to shift to xterm,
    // producing a spurious Enter that races the composed prompt through the PTY mutex.
    try {
      await writeToSession(sessionId, data);
      onClose();
    } catch (err) {
      console.error("[PromptComposer] Failed to send prompt:", err);
      // Don't close — let user retry or copy their prompt
    }
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

  const togglePin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSetting("pinned_templates", JSON.stringify([...next])).catch(console.error);
      return next;
    });
  }, []);

  // ── Bundle export/import handlers ────────────────────────────────────

  const builtInRoleIds = useMemo(() => new Set(BUILT_IN_ROLES.map((r) => r.id)), []);
  const builtInStyleIds = useMemo(() => new Set(BUILT_IN_STYLES.map((s) => s.id)), []);

  const handleExportTemplate = useCallback(async (tpl: PromptTemplate) => {
    try {
      const appVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";
      const bundle = createBundle([tpl], customRoles, customStyles, builtInRoleIds, builtInStyleIds, appVersion);
      const json = JSON.stringify(bundle, null, 2);
      const safeName = tpl.name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
      const path = await save({
        defaultPath: `${safeName}.hermes-prompts`,
        filters: [{ name: "Hermes Prompts", extensions: ["hermes-prompts"] }],
      });
      if (!path) return;
      await exportPromptBundle(path, json);
      addToast?.({ message: `Exported "${tpl.name}"`, type: "success", duration: 3000 });
    } catch (err) {
      console.error("[PromptComposer] Export failed:", err);
      addToast?.({ message: `Export failed: ${err}`, type: "error", duration: 5000 });
    }
  }, [customRoles, customStyles, builtInRoleIds, builtInStyleIds, addToast]);

  const handleExportAll = useCallback(async () => {
    if (userTemplates.length === 0) return;
    try {
      const appVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";
      const bundle = createBundle(userTemplates, customRoles, customStyles, builtInRoleIds, builtInStyleIds, appVersion);
      const json = JSON.stringify(bundle, null, 2);
      const path = await save({
        defaultPath: "my-prompts.hermes-prompts",
        filters: [{ name: "Hermes Prompts", extensions: ["hermes-prompts"] }],
      });
      if (!path) return;
      await exportPromptBundle(path, json);
      addToast?.({ message: `Exported ${userTemplates.length} template${userTemplates.length === 1 ? "" : "s"}`, type: "success", duration: 3000 });
    } catch (err) {
      console.error("[PromptComposer] Export all failed:", err);
      addToast?.({ message: `Export failed: ${err}`, type: "error", duration: 5000 });
    }
  }, [userTemplates, customRoles, customStyles, builtInRoleIds, builtInStyleIds, addToast]);

  const handleImportBundle = useCallback(async () => {
    try {
      const path = await open({
        filters: [{ name: "Hermes Prompts", extensions: ["hermes-prompts"] }],
        multiple: false,
        directory: false,
      });
      if (!path) return;
      const raw = await importPromptBundle(path as string);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        addToast?.({ message: "Invalid bundle file: not valid JSON", type: "error", duration: 5000 });
        return;
      }
      const validation = validateBundle(parsed);
      if (!validation.valid) {
        addToast?.({ message: validation.error, type: "error", duration: 5000 });
        return;
      }
      // Derive a default group name from the bundle
      const bundleName = validation.bundle._hermes_bundle_name
        ?? (path as string).split("/").pop()?.replace(/\.hermes-prompts$/i, "")
        ?? undefined;

      const { templates: newTemplates, roles: newRoles, styles: newStyles, result } = importBundle(
        validation.bundle, userTemplates, customRoles, customStyles, builtInRoleIds, builtInStyleIds,
        BUILT_IN_TEMPLATES,
        bundleName,
      );

      // Persist
      setUserTemplates(newTemplates);
      setCustomRoles(newRoles);
      setCustomStyles(newStyles);
      await setSetting("prompt_templates", JSON.stringify(newTemplates));
      await setSetting("custom_roles", JSON.stringify(newRoles));
      await setSetting("custom_styles", JSON.stringify(newStyles));

      // Auto-create group if templates were imported with a group name
      if (bundleName && !templateGroups.includes(bundleName) && result.templatesAdded > 0) {
        const updatedGroups = [...templateGroups, bundleName];
        setTemplateGroups(updatedGroups);
        await setSetting("template_groups", JSON.stringify(updatedGroups));
      }

      // Summary toast
      const parts: string[] = [];
      if (result.templatesAdded > 0) parts.push(`${result.templatesAdded} template${result.templatesAdded === 1 ? "" : "s"}`);
      if (result.rolesAdded > 0) parts.push(`${result.rolesAdded} role${result.rolesAdded === 1 ? "" : "s"}`);
      if (result.stylesAdded > 0) parts.push(`${result.stylesAdded} style${result.stylesAdded === 1 ? "" : "s"}`);
      const skipped = result.templatesSkipped > 0 ? ` (${result.templatesSkipped} skipped)` : "";
      const msg = parts.length > 0
        ? `Imported ${parts.join(", ")}${skipped}`
        : `Nothing new to import${skipped}`;
      addToast?.({ message: msg, type: parts.length > 0 ? "success" : "info", duration: 4000 });
    } catch (err) {
      console.error("[PromptComposer] Import failed:", err);
      addToast?.({ message: `Import failed: ${err}`, type: "error", duration: 5000 });
    }
  }, [userTemplates, customRoles, customStyles, builtInRoleIds, builtInStyleIds, addToast]);

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

  // Detect whether all fields are empty (for the empty-state CTA)
  const fieldsEmpty = useMemo(() => {
    return (
      fields.roleIds.length === 0 &&
      fields.styleSelections.length === 0 &&
      !fields.task.trim() &&
      !fields.scope.trim() &&
      !fields.constraints.trim() &&
      !fields.style.trim()
    );
  }, [fields]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (templatePickerOpen) {
        setTemplatePickerOpen(false);
        return;
      }
      onClose();
      return;
    }
    // Mod+T — toggle template picker
    if (e.key === "t" && isActionMod(e) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      toggleTemplatePicker();
      return;
    }
    if (e.key === "Enter" && isActionMod(e)) {
      e.preventDefault();
      e.stopPropagation();
      sendPrompt();
    }
  }, [onClose, sendPrompt, templatePickerOpen, toggleTemplatePicker]);

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="prompt-composer" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        {/* Header */}
        <div className="prompt-composer-header">
          <div className="prompt-composer-header-left">
            <span className="prompt-composer-title">Prompt Composer</span>
            <TemplatePicker
              builtInTemplates={BUILT_IN_TEMPLATES}
              userTemplates={userTemplates}
              onSelect={applyTemplate}
              onDeleteUser={deleteTemplate}
              open={templatePickerOpen}
              onToggle={toggleTemplatePicker}
              pinnedIds={pinnedIds}
              onTogglePin={togglePin}
              onExportTemplate={handleExportTemplate}
              onImportBundle={handleImportBundle}
              onExportAll={handleExportAll}
              templateGroups={templateGroups}
              onCreateGroup={createGroup}
              onRenameGroup={renameGroup}
              onDeleteGroup={deleteGroup}
              onMoveToGroup={moveToGroup}
            />
          </div>
          <button className="prompt-composer-close" onClick={onClose} title="Close (Esc)">&#10005;</button>
        </div>

        {/* Body: fields + preview */}
        <div className="prompt-composer-body">
          <div className="prompt-composer-fields">
            {/* Empty state CTA */}
            {fieldsEmpty && (
              <button
                className="prompt-composer-empty-cta"
                onClick={toggleTemplatePicker}
              >
                <span className="prompt-composer-empty-cta-icon">&#9776;</span>
                <span className="prompt-composer-empty-cta-text">
                  <strong>Start from a template</strong>
                  <span>Browse {BUILT_IN_TEMPLATES.length} ready-to-use prompt templates</span>
                </span>
                <kbd className="prompt-composer-empty-cta-kbd">{fmt("{mod}T")}</kbd>
              </button>
            )}

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
                  onContextMenu={textContextMenu}
                />
              </div>
            ))}

            {/* Advanced toggle */}
            <button
              className="prompt-composer-advanced-toggle"
              onClick={() => setAdvancedOpen(!advancedOpen)}
              title="Toggle advanced options"
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
                    onContextMenu={textContextMenu}
                  />
                </div>
                <div className="prompt-composer-field">
                  <label>Additional Style Notes</label>
                  <textarea
                    rows={2}
                    placeholder="Extra style instructions beyond the presets above. e.g. Show line references."
                    value={fields.style}
                    onChange={(e) => updateField("style", e.target.value)}
                    onContextMenu={textContextMenu}
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
                  onContextMenu={textContextMenu}
                />
                <button className="prompt-composer-btn prompt-composer-btn-sm" onClick={saveTemplate}>Save</button>
                <button className="prompt-composer-btn prompt-composer-btn-sm" onClick={() => setShowSaveInput(false)}>Cancel</button>
              </div>
            ) : (
              <button className="prompt-composer-btn" onClick={() => setShowSaveInput(true)}>Save Template</button>
            )}
            {!fieldsEmpty && (
              confirmingClear ? (
                <div className="prompt-composer-clear-confirm">
                  <span className="prompt-composer-clear-confirm-label">Clear all fields?</span>
                  <button className="prompt-composer-btn prompt-composer-btn-sm prompt-composer-btn-danger" onClick={clearFields}>Yes, clear</button>
                  <button className="prompt-composer-btn prompt-composer-btn-sm" onClick={() => setConfirmingClear(false)}>Cancel</button>
                </div>
              ) : (
                <button className="prompt-composer-btn prompt-composer-btn-clear" onClick={() => setConfirmingClear(true)}>Clear</button>
              )
            )}
          </div>
          <div className="prompt-composer-actions-right">
            <button className="prompt-composer-btn" onClick={copyPrompt} disabled={!compiled.trim()}>Copy</button>
            <button className="prompt-composer-btn prompt-composer-btn-send" onClick={sendPrompt} disabled={!compiled.trim()}>
              Send <kbd>{fmt("{mod}")}&#8629;</kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

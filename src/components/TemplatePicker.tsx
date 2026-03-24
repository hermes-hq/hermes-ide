import "../styles/components/TemplatePicker.css";
import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { TEMPLATE_CATEGORIES, type PromptTemplate, type TemplateCategory } from "../lib/templates";
import { fmt } from "../utils/platform";

interface TemplatePickerProps {
  builtInTemplates: PromptTemplate[];
  userTemplates: PromptTemplate[];
  onSelect: (template: PromptTemplate) => void;
  onDeleteUser: (id: string) => void;
  open: boolean;
  onToggle: () => void;
  pinnedIds: Set<string>;
  onTogglePin: (id: string) => void;
  onExportTemplate?: (template: PromptTemplate) => void;
  onImportBundle?: () => void;
  onExportAll?: () => void;
}

export function TemplatePicker({
  builtInTemplates,
  userTemplates,
  onSelect,
  onDeleteUser,
  open,
  onToggle,
  pinnedIds,
  onTogglePin,
  onExportTemplate,
  onImportBundle,
  onExportAll,
}: TemplatePickerProps) {
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null);

  // Position the dropdown using fixed coordinates from the button
  useEffect(() => {
    if (open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom + 6, left: rect.left });
      setSearch("");
      setHoveredId(null);
      requestAnimationFrame(() => searchRef.current?.focus());
    } else {
      setDropdownPos(null);
    }
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        btnRef.current && !btnRef.current.contains(target) &&
        dropdownRef.current && !dropdownRef.current.contains(target)
      ) {
        onToggle();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, onToggle]);

  const allTemplates = useMemo(
    () => [...builtInTemplates, ...userTemplates],
    [builtInTemplates, userTemplates],
  );

  // Filter templates by search query (also searches description)
  const filteredTemplates = useMemo(() => {
    if (!search.trim()) return null; // null = show grouped view
    const q = search.toLowerCase().trim();
    return allTemplates.filter((t) => {
      const catMeta = TEMPLATE_CATEGORIES[t.category];
      return (
        t.name.toLowerCase().includes(q) ||
        (t.description && t.description.toLowerCase().includes(q)) ||
        (catMeta && catMeta.label.toLowerCase().includes(q))
      );
    });
  }, [search, allTemplates]);

  // Group built-in templates by category
  const categories = Object.keys(TEMPLATE_CATEGORIES) as TemplateCategory[];
  const grouped = useMemo(() => {
    const map = new Map<TemplateCategory, PromptTemplate[]>();
    for (const cat of categories) {
      const items = builtInTemplates.filter((t) => t.category === cat);
      if (items.length > 0) map.set(cat, items);
    }
    return map;
  }, [builtInTemplates]);

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const hoveredTemplate = useMemo(
    () => (hoveredId ? allTemplates.find((t) => t.id === hoveredId) ?? null : null),
    [hoveredId, allTemplates],
  );

  // Collect pinned templates (preserving pin order)
  const pinnedTemplates = useMemo(() => {
    if (pinnedIds.size === 0) return [];
    const map = new Map(allTemplates.map((t) => [t.id, t]));
    return [...pinnedIds].map((id) => map.get(id)).filter(Boolean) as PromptTemplate[];
  }, [pinnedIds, allTemplates]);

  const handleSelect = useCallback((tpl: PromptTemplate) => {
    onSelect(tpl);
    onToggle();
  }, [onSelect, onToggle]);

  const renderItem = (tpl: PromptTemplate, showCategory?: boolean) => {
    const isPinned = pinnedIds.has(tpl.id);
    return (
      <div
        key={tpl.id}
        className={`template-picker-item ${!tpl.builtIn ? "template-picker-item-user" : ""}`}
        onClick={() => handleSelect(tpl)}
        onMouseEnter={() => setHoveredId(tpl.id)}
        onMouseLeave={() => setHoveredId(null)}
      >
        <span className="template-picker-item-name">{tpl.name}</span>
        {showCategory && (
          <span className="template-picker-item-cat">
            {TEMPLATE_CATEGORIES[tpl.category]?.label}
          </span>
        )}
        <button
          className={`template-picker-item-pin${isPinned ? " pinned" : ""}`}
          onClick={(e) => { e.stopPropagation(); onTogglePin(tpl.id); }}
          title={isPinned ? "Unpin template" : "Pin template"}
        >
          📌
        </button>
        {!tpl.builtIn && onExportTemplate && (
          <button
            className="template-picker-item-export"
            onClick={(e) => { e.stopPropagation(); onExportTemplate(tpl); }}
            title="Export template"
          >
            &#8599;
          </button>
        )}
        {!tpl.builtIn && (
          <button
            className="template-picker-item-delete"
            onClick={(e) => { e.stopPropagation(); onDeleteUser(tpl.id); }}
            title="Delete template"
          >
            x
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="template-picker-wrapper">
      <button
        ref={btnRef}
        className="template-picker-btn"
        onClick={onToggle}
        title={`Browse templates (${fmt("{mod}T")})`}
      >
        <span className="template-picker-btn-icon">&#9776;</span>
        Templates
      </button>

      {open && dropdownPos && (
        <div
          ref={dropdownRef}
          className="template-picker-dropdown"
          style={{ top: dropdownPos.top, left: dropdownPos.left }}
        >
          {/* Search */}
          <div className="template-picker-search-wrap">
            <input
              ref={searchRef}
              className="template-picker-search"
              type="text"
              placeholder="Search templates..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  if (search) setSearch("");
                  else onToggle();
                }
              }}
            />
            {search && (
              <button
                className="template-picker-search-clear"
                onClick={() => { setSearch(""); searchRef.current?.focus(); }}
              >
                &#10005;
              </button>
            )}
          </div>

          {/* Import / Export All actions */}
          {(onImportBundle || (onExportAll && userTemplates.length > 0)) && (
            <div className="template-picker-bundle-actions">
              {onImportBundle && (
                <button
                  className="template-picker-bundle-btn"
                  onClick={(e) => { e.stopPropagation(); onImportBundle(); }}
                  title="Import templates from a .hermes-prompts file"
                >
                  Import
                </button>
              )}
              {onExportAll && userTemplates.length > 0 && (
                <button
                  className="template-picker-bundle-btn"
                  onClick={(e) => { e.stopPropagation(); onExportAll(); }}
                  title="Export all saved templates to a .hermes-prompts file"
                >
                  Export All
                </button>
              )}
            </div>
          )}

          <div className="template-picker-list">
            {/* Search results mode */}
            {filteredTemplates !== null ? (
              filteredTemplates.length > 0 ? (
                filteredTemplates.map((tpl) => renderItem(tpl, true))
              ) : (
                <div className="template-picker-empty">No templates match &ldquo;{search}&rdquo;</div>
              )
            ) : (
              /* Grouped category mode (no search) */
              <>
                {pinnedTemplates.length > 0 && (
                  <>
                    <div className="template-picker-section-label template-picker-section-pinned">📌 Pinned</div>
                    <div className="template-picker-items">
                      {pinnedTemplates.map((tpl) => renderItem(tpl))}
                    </div>
                  </>
                )}
                {Array.from(grouped.entries()).map(([cat, items]) => {
                  const meta = TEMPLATE_CATEGORIES[cat];
                  const collapsed = collapsedCategories.has(cat);
                  return (
                    <div key={cat}>
                      <div
                        className="template-picker-category"
                        onClick={() => toggleCategory(cat)}
                      >
                        <span className="template-picker-category-chevron">
                          {collapsed ? "\u25b8" : "\u25be"}
                        </span>
                        <span className="template-picker-category-icon">{meta.icon}</span>
                        <span className="template-picker-category-label">{meta.label}</span>
                        <span className="template-picker-category-count">{items.length}</span>
                      </div>
                      {!collapsed && (
                        <div className="template-picker-items">
                          {items.map((tpl) => renderItem(tpl))}
                        </div>
                      )}
                    </div>
                  );
                })}

                {userTemplates.length > 0 && (
                  <>
                    <div className="template-picker-section-label">Saved</div>
                    {userTemplates.map((tpl) => renderItem(tpl))}
                  </>
                )}

              </>
            )}
          </div>

          {/* Description preview — shown on hover */}
          {hoveredTemplate && hoveredTemplate.description && (
            <div className="template-picker-preview">
              <span className="template-picker-preview-name">{hoveredTemplate.name}</span>
              <span className="template-picker-preview-desc">{hoveredTemplate.description}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

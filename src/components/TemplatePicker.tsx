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
  templateGroups: string[];
  onCreateGroup: (name: string) => void;
  onRenameGroup: (oldName: string, newName: string) => void;
  onDeleteGroup: (name: string) => void;
  onMoveToGroup: (templateId: string, group: string | null) => void;
}

type TabId = "built-in" | "my-templates";

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
  templateGroups,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onMoveToGroup,
}: TemplatePickerProps) {
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("built-in");
  const [newGroupName, setNewGroupName] = useState("");
  const [showNewGroupInput, setShowNewGroupInput] = useState(false);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [moveMenuId, setMoveMenuId] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const newGroupRef = useRef<HTMLInputElement>(null);
  const editGroupRef = useRef<HTMLInputElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null);

  // Position the dropdown using fixed coordinates from the button
  useEffect(() => {
    if (open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom + 6, left: rect.left });
      setSearch("");
      setHoveredId(null);
      setMoveMenuId(null);
      setShowNewGroupInput(false);
      setEditingGroup(null);
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

  // Focus new group input when shown
  useEffect(() => {
    if (showNewGroupInput) requestAnimationFrame(() => newGroupRef.current?.focus());
  }, [showNewGroupInput]);

  // Focus edit group input when shown
  useEffect(() => {
    if (editingGroup) requestAnimationFrame(() => editGroupRef.current?.focus());
  }, [editingGroup]);

  const allTemplates = useMemo(
    () => [...builtInTemplates, ...userTemplates],
    [builtInTemplates, userTemplates],
  );

  // Filter templates by search query within the active tab
  const filteredTemplates = useMemo(() => {
    if (!search.trim()) return null;
    const q = search.toLowerCase().trim();
    const source = activeTab === "built-in" ? builtInTemplates : userTemplates;
    return source.filter((t) => {
      const catMeta = TEMPLATE_CATEGORIES[t.category];
      return (
        t.name.toLowerCase().includes(q) ||
        (t.description && t.description.toLowerCase().includes(q)) ||
        (catMeta && catMeta.label.toLowerCase().includes(q)) ||
        (t.group && t.group.toLowerCase().includes(q))
      );
    });
  }, [search, activeTab, builtInTemplates, userTemplates]);

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

  // Group user templates by their group field
  const userGrouped = useMemo(() => {
    const map = new Map<string, PromptTemplate[]>();
    // Initialize with known groups (preserves order and allows empty groups)
    for (const g of templateGroups) {
      map.set(g, []);
    }
    const ungrouped: PromptTemplate[] = [];
    for (const tpl of userTemplates) {
      if (tpl.group) {
        const list = map.get(tpl.group);
        if (list) list.push(tpl);
        else map.set(tpl.group, [tpl]); // group exists on template but not in templateGroups list
      } else {
        ungrouped.push(tpl);
      }
    }
    return { groups: map, ungrouped };
  }, [userTemplates, templateGroups]);

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

  const handleCreateGroup = useCallback(() => {
    const trimmed = newGroupName.trim();
    if (!trimmed) return;
    onCreateGroup(trimmed);
    setNewGroupName("");
    setShowNewGroupInput(false);
  }, [newGroupName, onCreateGroup]);

  const handleRenameGroup = useCallback(() => {
    if (!editingGroup) return;
    const trimmed = editingGroupName.trim();
    if (trimmed && trimmed !== editingGroup) {
      onRenameGroup(editingGroup, trimmed);
    }
    setEditingGroup(null);
    setEditingGroupName("");
  }, [editingGroup, editingGroupName, onRenameGroup]);

  const renderItem = (tpl: PromptTemplate, showCategory?: boolean) => {
    const isPinned = pinnedIds.has(tpl.id);
    const isUser = !tpl.builtIn;
    return (
      <div
        key={tpl.id}
        className={`template-picker-item ${isUser ? "template-picker-item-user" : ""}`}
        onClick={() => handleSelect(tpl)}
        onMouseEnter={() => setHoveredId(tpl.id)}
        onMouseLeave={() => { setHoveredId(null); setMoveMenuId(null); }}
      >
        <span className="template-picker-item-name">{tpl.name}</span>
        {showCategory && (
          <span className="template-picker-item-cat">
            {tpl.group || TEMPLATE_CATEGORIES[tpl.category]?.label}
          </span>
        )}
        <span className="template-picker-item-actions">
          <button
            className={`template-picker-item-pin${isPinned ? " pinned" : ""}`}
            onClick={(e) => { e.stopPropagation(); onTogglePin(tpl.id); }}
            title={isPinned ? "Unpin template" : "Pin template"}
          >
            📌
          </button>
          {isUser && (
            <>
              <button
                className="template-picker-item-move"
                onClick={(e) => { e.stopPropagation(); setMoveMenuId(moveMenuId === tpl.id ? null : tpl.id); }}
                title="Move to group"
              >
                📁
              </button>
              {moveMenuId === tpl.id && (
                <div className="template-picker-move-menu" onClick={(e) => e.stopPropagation()}>
                  <div
                    className="template-picker-move-option"
                    onClick={() => { onMoveToGroup(tpl.id, null); setMoveMenuId(null); }}
                  >
                    Ungrouped
                  </div>
                  {templateGroups.map((g) => (
                    <div
                      key={g}
                      className={`template-picker-move-option${tpl.group === g ? " active" : ""}`}
                      onClick={() => { onMoveToGroup(tpl.id, g); setMoveMenuId(null); }}
                    >
                      {g}
                    </div>
                  ))}
                </div>
              )}
              {onExportTemplate && (
                <button
                  className="template-picker-item-export"
                  onClick={(e) => { e.stopPropagation(); onExportTemplate(tpl); }}
                  title="Export template"
                >
                  &#8599;
                </button>
              )}
              <button
                className="template-picker-item-delete"
                onClick={(e) => { e.stopPropagation(); onDeleteUser(tpl.id); }}
                title="Delete template"
              >
                x
              </button>
            </>
          )}
        </span>
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

          {/* Tabs */}
          <div className="template-picker-tabs">
            <button
              className={`template-picker-tab${activeTab === "built-in" ? " template-picker-tab-active" : ""}`}
              onClick={() => setActiveTab("built-in")}
            >
              Built-in
            </button>
            <button
              className={`template-picker-tab${activeTab === "my-templates" ? " template-picker-tab-active" : ""}`}
              onClick={() => setActiveTab("my-templates")}
            >
              My Templates
              {userTemplates.length > 0 && (
                <span className="template-picker-tab-count">{userTemplates.length}</span>
              )}
            </button>
          </div>

          <div className="template-picker-list">
            {/* Pinned — always visible at top of list */}
            {pinnedTemplates.length > 0 && !search && (
              <>
                <div className="template-picker-section-label template-picker-section-pinned">📌 Pinned</div>
                <div className="template-picker-items">
                  {pinnedTemplates.map((tpl) => renderItem(tpl))}
                </div>
              </>
            )}

            {/* Search results mode */}
            {filteredTemplates !== null ? (
              filteredTemplates.length > 0 ? (
                filteredTemplates.map((tpl) => renderItem(tpl, true))
              ) : (
                <div className="template-picker-empty">No templates match &ldquo;{search}&rdquo;</div>
              )
            ) : activeTab === "built-in" ? (
              /* Built-in tab: category-grouped view */
              <>
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
              </>
            ) : (
              /* My Templates tab: group-based view */
              <>
                {/* Import / Export actions */}
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

                {/* New Group button / input */}
                {showNewGroupInput ? (
                  <div className="template-picker-new-group">
                    <input
                      ref={newGroupRef}
                      className="template-picker-new-group-input"
                      type="text"
                      placeholder="Group name..."
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleCreateGroup();
                        if (e.key === "Escape") { setShowNewGroupInput(false); setNewGroupName(""); }
                      }}
                      onBlur={() => { if (!newGroupName.trim()) { setShowNewGroupInput(false); setNewGroupName(""); } }}
                    />
                    <button className="template-picker-new-group-ok" onClick={handleCreateGroup}>+</button>
                  </div>
                ) : (
                  <button
                    className="template-picker-new-group-btn"
                    onClick={() => setShowNewGroupInput(true)}
                  >
                    + New Group
                  </button>
                )}

                {/* Grouped templates */}
                {Array.from(userGrouped.groups.entries()).map(([groupName, items]) => {
                  const collapsed = collapsedCategories.has(`group:${groupName}`);
                  return (
                    <div key={`group:${groupName}`}>
                      <div
                        className="template-picker-category template-picker-group-header"
                        onClick={() => toggleCategory(`group:${groupName}`)}
                      >
                        <span className="template-picker-category-chevron">
                          {collapsed ? "\u25b8" : "\u25be"}
                        </span>
                        <span className="template-picker-category-icon">📁</span>
                        {editingGroup === groupName ? (
                          <input
                            ref={editGroupRef}
                            className="template-picker-group-edit-input"
                            value={editingGroupName}
                            onChange={(e) => setEditingGroupName(e.target.value)}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === "Enter") handleRenameGroup();
                              if (e.key === "Escape") { setEditingGroup(null); setEditingGroupName(""); }
                            }}
                            onBlur={handleRenameGroup}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <span className="template-picker-category-label">{groupName}</span>
                        )}
                        <span className="template-picker-category-count">{items.length}</span>
                        <span className="template-picker-group-actions">
                          <button
                            className="template-picker-group-action"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingGroup(groupName);
                              setEditingGroupName(groupName);
                            }}
                            title="Rename group"
                          >
                            &#9998;
                          </button>
                          <button
                            className="template-picker-group-action"
                            onClick={(e) => { e.stopPropagation(); onDeleteGroup(groupName); }}
                            title="Delete group (templates are kept)"
                          >
                            x
                          </button>
                        </span>
                      </div>
                      {!collapsed && (
                        <div className="template-picker-items">
                          {items.length > 0
                            ? items.map((tpl) => renderItem(tpl))
                            : <div className="template-picker-empty-group">No templates in this group</div>
                          }
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Ungrouped templates */}
                {userGrouped.ungrouped.length > 0 && (
                  <>
                    <div className="template-picker-section-label">Ungrouped</div>
                    <div className="template-picker-items">
                      {userGrouped.ungrouped.map((tpl) => renderItem(tpl))}
                    </div>
                  </>
                )}

                {userTemplates.length === 0 && templateGroups.length === 0 && (
                  <div className="template-picker-empty">
                    No saved templates yet. Save a prompt or import a bundle.
                  </div>
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

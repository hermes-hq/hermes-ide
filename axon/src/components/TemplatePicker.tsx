import "../styles/components/TemplatePicker.css";
import { useState, useRef, useEffect } from "react";
import { TEMPLATE_CATEGORIES, type PromptTemplate, type TemplateCategory } from "../lib/templates";

interface TemplatePickerProps {
  builtInTemplates: PromptTemplate[];
  userTemplates: PromptTemplate[];
  onSelect: (template: PromptTemplate) => void;
  onDeleteUser: (id: string) => void;
}

export function TemplatePicker({
  builtInTemplates,
  userTemplates,
  onSelect,
  onDeleteUser,
}: TemplatePickerProps) {
  const [open, setOpen] = useState(false);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Group built-in templates by category
  const categories = Object.keys(TEMPLATE_CATEGORIES) as TemplateCategory[];
  const grouped = new Map<TemplateCategory, PromptTemplate[]>();
  for (const cat of categories) {
    const items = builtInTemplates.filter((t) => t.category === cat);
    if (items.length > 0) grouped.set(cat, items);
  }

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  return (
    <div className="template-picker-wrapper" ref={wrapperRef}>
      <button
        className="template-picker-btn"
        onClick={() => setOpen(!open)}
      >
        Templates
      </button>

      {open && (
        <div className="template-picker-dropdown">
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
                    {items.map((tpl) => (
                      <div
                        key={tpl.id}
                        className="template-picker-item"
                        onClick={() => {
                          onSelect(tpl);
                          setOpen(false);
                        }}
                      >
                        {tpl.name}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {userTemplates.length > 0 && (
            <>
              <div className="template-picker-section-label">Saved</div>
              {userTemplates.map((tpl) => (
                <div
                  key={tpl.id}
                  className="template-picker-item template-picker-item-user"
                  onClick={() => {
                    onSelect(tpl);
                    setOpen(false);
                  }}
                >
                  <span>{tpl.name}</span>
                  <button
                    className="template-picker-item-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteUser(tpl.id);
                    }}
                    title="Delete template"
                  >
                    x
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

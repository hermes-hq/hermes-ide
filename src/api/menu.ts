import { invoke } from "@tauri-apps/api/core";

// ─── Types ──────────────────────────────────────────────────────────

export interface ContextMenuItem {
  id: string;
  label: string;
  enabled?: boolean;
  is_separator?: boolean;
  checked?: boolean | null;
  accelerator?: string | null;
  children?: ContextMenuItem[];
}

export interface MenuItemUpdate {
  id: string;
  enabled?: boolean;
  checked?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────

export function separator(): ContextMenuItem {
  return { id: "", label: "", is_separator: true };
}

export function menuItem(
  id: string,
  label: string,
  opts?: { enabled?: boolean; accelerator?: string; checked?: boolean },
): ContextMenuItem {
  return { id, label, enabled: opts?.enabled ?? true, checked: opts?.checked ?? null, accelerator: opts?.accelerator ?? null };
}

export function subMenu(label: string, children: ContextMenuItem[]): ContextMenuItem {
  return { id: "", label, children, enabled: true };
}

// ─── Tauri Commands ─────────────────────────────────────────────────

export function showContextMenu(items: ContextMenuItem[]): Promise<void> {
  return invoke<void>("show_context_menu", { items });
}

export function updateMenuState(updates: MenuItemUpdate[]): Promise<void> {
  return invoke<void>("update_menu_state", { updates });
}

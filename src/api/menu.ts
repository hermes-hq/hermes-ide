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
  /** A new label for the item (F21: "Git Panel" reads "Review Desk" with the flag on). */
  text?: string;
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

/** Test builds only (VITE_HERMES_E2E=1): a script cannot click a native
 *  popup, so the real-app test rig may install this to receive the menu
 *  instead and answer with the same "menu-action" event the popup emits.
 *  Normal builds replace the flag at build time and drop this path. */
type E2eMenuHook = (items: ContextMenuItem[]) => Promise<void>;

export function showContextMenu(items: ContextMenuItem[]): Promise<void> {
  if (import.meta.env.VITE_HERMES_E2E === "1") {
    const hook = (window as unknown as { __HERMES_E2E_MENU__?: E2eMenuHook }).__HERMES_E2E_MENU__;
    if (hook) return hook(items);
  }
  return invoke<void>("show_context_menu", { items });
}

export function updateMenuState(updates: MenuItemUpdate[]): Promise<void> {
  return invoke<void>("update_menu_state", { updates });
}

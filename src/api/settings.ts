import { invoke } from "@tauri-apps/api/core";

export type SettingsMap = Record<string, string>;

export function getSettings(): Promise<SettingsMap> {
  return invoke<SettingsMap>("get_settings");
}

export async function getSetting(key: string): Promise<string> {
  // NOTE: There is no singular "get_setting" Tauri command — only "get_settings"
  // (plural) is registered.  We fetch all settings and extract the requested key.
  const all = await invoke<SettingsMap>("get_settings");
  return all[key] ?? "";
}

export function setSetting(key: string, value: string): Promise<void> {
  return invoke("set_setting", { key, value });
}

export function exportSettings(path: string): Promise<void> {
  return invoke("export_settings", { path });
}

export function importSettings(path: string): Promise<SettingsMap> {
  return invoke<SettingsMap>("import_settings", { path });
}

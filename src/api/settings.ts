import { invoke } from "@tauri-apps/api/core";

export type SettingsMap = Record<string, string>;

export function getSettings(): Promise<SettingsMap> {
  return invoke<SettingsMap>("get_settings");
}

export function getSetting(key: string): Promise<string> {
  return invoke<string>("get_setting", { key });
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

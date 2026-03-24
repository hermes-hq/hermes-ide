// ─── Prompt Bundle API ────────────────────────────────────────────────
//
// Thin wrappers around the Tauri commands for reading/writing
// .hermes-prompts bundle files.

import { invoke } from "@tauri-apps/api/core";

export function exportPromptBundle(path: string, data: string): Promise<void> {
	return invoke("export_prompt_bundle", { path, data });
}

export function importPromptBundle(path: string): Promise<string> {
	return invoke<string>("import_prompt_bundle", { path });
}

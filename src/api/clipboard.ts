import { invoke } from "@tauri-apps/api/core";

/** Copy an image file to the system clipboard as image data + path text. */
export function copyImageToClipboard(path: string): Promise<void> {
  return invoke("copy_image_to_clipboard", { path });
}

/** Copy an image to clipboard WITHOUT setting text (image preserved on macOS).
 *  Required when pasting into a TUI like Claude Code. */
export function copyImageOnlyToClipboard(path: string): Promise<void> {
  return invoke("copy_image_only_to_clipboard", { path });
}

import { invoke } from "@tauri-apps/api/core";

/** Copy an image file to the system clipboard as image data. */
export function copyImageToClipboard(path: string): Promise<void> {
  return invoke("copy_image_to_clipboard", { path });
}

/** Read an image file and return a base64 data URI for display. */
export function readImageBase64(path: string): Promise<string> {
  return invoke("read_image_base64", { path });
}

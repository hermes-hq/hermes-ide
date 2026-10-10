// ─── Files and images attached in the task launcher ────────────────────
//
// A file dropped on the launcher or picked with "Attach…" is named where it
// is. Something pasted from the clipboard (a screenshot) has no file behind
// it: the backend saves it first (save_launch_attachment) and the launcher
// keeps that path. On launch the agent's first prompt lists every path after
// the task, which every agent that takes a first prompt can read; an Agent
// view session also gets the images as images on its first message.

import { invoke } from "@tauri-apps/api/core";
import { readImageForAttachment } from "../api/agent";
import type { AgentAttachment } from "../utils/submitToAgent";

export interface LaunchAttachment {
  /** Absolute path on disk. */
  path: string;
  /** What the chip shows. */
  name: string;
  image: boolean;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

export function isImageName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** The MIME type of an image file by its extension (for an Agent view image). */
export function imageMediaType(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return `image/${ext}`;
}

export function attachmentFromPath(path: string): LaunchAttachment {
  const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
  return { path, name, image: isImageName(name) };
}

/** `list` with `more` added after it; a path already attached is not added twice. */
export function addAttachments(list: readonly LaunchAttachment[], more: readonly LaunchAttachment[]): LaunchAttachment[] {
  const seen = new Set(list.map((a) => a.path));
  const out = [...list];
  for (const a of more) {
    if (seen.has(a.path)) continue;
    seen.add(a.path);
    out.push(a);
  }
  return out;
}

/** The first prompt with the attached files listed after it. */
export function promptWithAttachments(prompt: string, attachments: readonly LaunchAttachment[] | undefined): string {
  if (!attachments || attachments.length === 0) return prompt;
  const list = attachments.map((a) => `- ${a.path}`).join("\n");
  const head = attachments.length === 1 ? "Attached file (read it):" : "Attached files (read them):";
  return `${prompt.trimEnd()}\n\n${head}\n${list}`;
}

/**
 * The name a pasted file is saved under. A browser or the system names a
 * clipboard image "image.png" (or nothing): it becomes
 * "pasted-image-<n>.<ext>" so several pastes read apart.
 */
export function pastedFileName(file: { name: string; type: string }, n: number): string {
  const generic = !file.name || /^image\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(file.name);
  if (!generic) return file.name;
  const ext = file.name.includes(".")
    ? file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase()
    : (file.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/\+.*$/, "");
  return `pasted-image-${n}.${ext}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function saveLaunchAttachment(name: string, bytes: Uint8Array): Promise<string> {
  return invoke<string>("save_launch_attachment", { name, data: toBase64(bytes) });
}

/** Save a pasted file and return it as an attachment. */
export async function attachPastedFile(
  file: File,
  n: number,
  save: (name: string, bytes: Uint8Array) => Promise<string> = saveLaunchAttachment,
): Promise<LaunchAttachment> {
  const name = pastedFileName(file, n);
  const path = await save(name, new Uint8Array(await file.arrayBuffer()));
  return { ...attachmentFromPath(path), name };
}

/** The images at `paths` as Agent view attachments; one that cannot be read is left out. */
export async function loadImageAttachments(
  paths: readonly string[],
  read: (path: string) => Promise<number[]> = readImageForAttachment,
): Promise<AgentAttachment[]> {
  const out: AgentAttachment[] = [];
  for (const path of paths) {
    try {
      const bytes = Uint8Array.from(await read(path));
      out.push({ kind: "image", mediaType: imageMediaType(path), base64: toBase64(bytes) });
    } catch (err) {
      console.warn("[attachments] could not read an attached image:", err);
    }
  }
  return out;
}

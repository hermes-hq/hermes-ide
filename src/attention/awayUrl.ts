// ─── The away-notification address (N16) ──────────────────────────────
//
// Empty (off) or an http(s) URL. The backend (src-tauri/src/attention/away.rs)
// applies the same rule before it sends anything.

export function isAwayUrlAcceptable(value: string): boolean {
  const v = value.trim();
  if (v === "") return true;
  try {
    const url = new URL(v);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname !== "";
  } catch {
    return false;
  }
}

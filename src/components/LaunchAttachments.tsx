import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type RefObject } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useI18n } from "../i18n/I18nProvider";
import { Button, Chip } from "./ui";
import { readImageForAttachment } from "../api/agent";
import {
  addAttachments,
  attachmentFromPath,
  attachPastedFile,
  imageMediaType,
  type LaunchAttachment,
} from "../launcher/attachments";

type SetAttachments = (update: (cur: LaunchAttachment[]) => LaunchAttachment[]) => void;

/**
 * Paste and "Attach…" for the task launcher. A paste with files in it (a
 * screenshot, an image copied from a browser) attaches them instead of
 * pasting text; a paste of text stays a paste of text.
 */
export function useLaunchAttachmentInput(setAttachments: SetAttachments) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const pasted = useRef(0);

  const add = useCallback(
    (more: LaunchAttachment[]) => {
      if (more.length === 0) return;
      setAttachments((cur) => addAttachments(cur, more));
      setError(null);
    },
    [setAttachments],
  );

  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      // Text with only the clipboard's own picture of it (cells copied from a
      // spreadsheet show up as an "image.png" too): the text is what was meant.
      // An image copied from a browser carries just its address as text: the image is.
      const text = (e.clipboardData?.getData("text/plain") ?? "").trim();
      const onlyAddress = /^(https?|file|data|blob):\S+$/i.test(text);
      if (text && !onlyAddress && files.every((f) => !f.name || f.name === "image.png")) return;
      e.preventDefault();
      void (async () => {
        for (const file of files) {
          try {
            add([await attachPastedFile(file, ++pasted.current)]);
          } catch (err) {
            setError(t("launcher.attachFailed", { name: file.name || "image", reason: err instanceof Error ? err.message : String(err) }));
          }
        }
      })();
    },
    [add, t],
  );

  const pick = useCallback(async () => {
    try {
      const picked = await open({ multiple: true, directory: false });
      const paths = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
      add(paths.map(attachmentFromPath));
    } catch (err) {
      console.warn("[LaunchAttachments] the file picker failed:", err);
    }
  }, [add]);

  return { add, onPaste, pick, error };
}

/**
 * Files dropped anywhere on `rootRef` while it is on screen. Returns whether
 * files are being dragged over it (for the drop highlight).
 */
export function useFileDrop(rootRef: RefObject<HTMLElement | null>, onDrop: (paths: string[]) => void): boolean {
  const [over, setOver] = useState(false);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    let files = false;
    const inside = (pos: { x: number; y: number }) => {
      const root = rootRef.current;
      if (!root) return false;
      const dpr = window.devicePixelRatio || 1;
      const el = document.elementFromPoint(pos.x / dpr, pos.y / dpr);
      return !!el && root.contains(el);
    };
    let webview: ReturnType<typeof getCurrentWebview>;
    try {
      webview = getCurrentWebview();
    } catch {
      return; // Not inside the app (tests, a plain browser): no native drops.
    }
    webview
      .onDragDropEvent((event) => {
        if (cancelled) return;
        const p = event.payload;
        if (p.type === "leave") {
          files = false;
          setOver(false);
        } else if (p.type === "enter") {
          files = p.paths.length > 0;
          setOver(files && inside(p.position));
        } else if (p.type === "over") {
          setOver(files && inside(p.position));
        } else if (p.type === "drop") {
          setOver(false);
          if (p.paths.length > 0 && inside(p.position)) onDropRef.current(p.paths);
          files = false;
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [rootRef]);
  return over;
}

/** Image previews for attached images, read from disk once each. */
function usePreviews(attachments: readonly LaunchAttachment[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const made = useRef<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    for (const a of attachments) {
      if (!a.image || made.current[a.path]) continue;
      made.current[a.path] = "pending";
      readImageForAttachment(a.path)
        .then((bytes) => {
          const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: imageMediaType(a.path) }));
          made.current[a.path] = url;
          if (alive) setUrls((cur) => ({ ...cur, [a.path]: url }));
          else URL.revokeObjectURL(url);
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [attachments]);
  useEffect(
    () => () => {
      for (const url of Object.values(made.current)) if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    },
    [],
  );
  return urls;
}

interface LaunchAttachmentsProps {
  attachments: LaunchAttachment[];
  onRemove: (path: string) => void;
  onPick: () => void;
  error: string | null;
  dragOver: boolean;
}

/** The attachments under the task: a chip per file, and "Attach…". */
export function LaunchAttachments({ attachments, onRemove, onPick, error, dragOver }: LaunchAttachmentsProps) {
  const { t } = useI18n();
  const previews = usePreviews(attachments);
  return (
    <div className="task-launcher-attachments" data-testid="launcher-attachments" data-drag-over={dragOver ? "true" : undefined}>
      <Button size="sm" variant="quiet" className="task-launcher-attach" onClick={onPick} title={t("launcher.attachHint")}>
        {t("launcher.attach")}
      </Button>
      {attachments.map((a) => (
        <Chip
          key={a.path}
          size="sm"
          className="task-launcher-attachment"
          onRemove={() => onRemove(a.path)}
          removeLabel={t("launcher.attachmentRemove", { name: a.name })}
        >
          <span className="task-launcher-attachment-body" title={a.path} data-path={a.path} data-image={a.image ? "true" : "false"}>
            {a.image && previews[a.path] ? (
              <img className="task-launcher-attachment-thumb" src={previews[a.path]} alt="" />
            ) : null}
            {a.name}
          </span>
        </Chip>
      ))}
      {dragOver && <span className="task-launcher-attach-drop">{t("launcher.dropToAttach")}</span>}
      {error && (
        <span className="task-launcher-attach-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

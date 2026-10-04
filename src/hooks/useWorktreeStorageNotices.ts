import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { translate } from "../i18n/registry";
import { isFeatureFlagEnabled } from "../featureFlags";
import { formatStorageBytes, STORAGE_NOTICE_EVENT, type StorageNotice } from "../api/worktreeStorage";
import type { Toast } from "./useToastStore";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The toast for one notice of the background worktree pass
 * (src-tauri/src/git/hygiene_app.rs): low disk space, space it freed, or
 * old worktrees with work in them taking a lot of room. Each offers
 * "Review storage".
 */
export function storageNoticeToast(
  n: StorageNotice,
  onReview: () => void,
  t: Translate = translate,
): Omit<Toast, "id"> {
  const size = formatStorageBytes;
  const review = [{ label: t("storage.notice.review"), onClick: onReview }];
  switch (n.kind) {
    case "low_disk":
      return {
        message: n.worktreeBytes > 0
          ? t("storage.notice.lowDisk", { free: size(n.freeBytes ?? 0), total: size(n.worktreeBytes), auto: size(n.autoBytes) })
          : t("storage.notice.lowDiskPlain", { free: size(n.freeBytes ?? 0) }),
        type: "warning",
        duration: null,
        actions: review,
      };
    case "cleaned":
      return {
        message: t("storage.notice.cleaned", { size: size(n.freedBytes) }),
        type: "info",
        duration: 10000,
        actions: review,
      };
    case "reclaimable":
    default:
      return {
        message: t("storage.notice.reclaimable", { size: size(n.needsBytes) }),
        type: "info",
        duration: 20000,
        actions: review,
      };
  }
}

/** Shows the background worktree pass's notices as toasts (diskGuard flag). */
export function useWorktreeStorageNotices(
  addToast: (toast: Omit<Toast, "id">) => string,
  openStorage: () => void,
): void {
  const latest = useRef({ addToast, openStorage });
  latest.current = { addToast, openStorage };
  useEffect(() => {
    if (!isFeatureFlagEnabled("diskGuard")) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<StorageNotice>(STORAGE_NOTICE_EVENT, (event) => {
      if (cancelled) return;
      latest.current.addToast(storageNoticeToast(event.payload, () => latest.current.openStorage()));
    }).then((u) => {
      if (cancelled) u(); else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}

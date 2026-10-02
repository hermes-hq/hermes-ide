// ─── "Make it a feature", with Undo ───────────────────────────────────
//
// Shared by the Track panel and the command palette: create the feature
// folder (and the phase prompts and the command, where missing), then offer
// Undo in the toast. Undo removes exactly the files that were written and
// that nobody changed since; a changed file is kept and named.

import type { ToastStore } from "../hooks/useToastStore";
import { trackPromote, trackUndoPromote, type PromoteOutcome } from "./api";

type T = (key: string, values?: Record<string, string | number>) => string;

export async function promoteWithUndo(
  worktree: string,
  slug: string,
  track: string,
  toast: Pick<ToastStore, "addToast" | "dismissToast">,
  t: T,
): Promise<PromoteOutcome> {
  const out = await trackPromote(worktree, slug, track, null);
  const made = out.created ? t("track.featureCreated", { slug: out.slug, track }) : t("track.quickNoFolder", { slug: out.slug });
  const message = out.branch ? `${made} — ${out.branch}` : made;
  if (out.written.length === 0) {
    toast.addToast({ message, type: "success", duration: 4000 });
    return out;
  }
  const id = toast.addToast({
    message,
    type: "success",
    duration: 15_000,
    actions: [
      {
        label: t("track.undo"),
        onClick: () => {
          toast.dismissToast(id);
          trackUndoPromote(worktree, out.written)
            .then((undo) =>
              toast.addToast({
                message:
                  undo.kept.length === 0
                    ? t("track.undoneFeature", { slug: out.slug })
                    : t("track.undoneFeatureKept", { slug: out.slug, files: undo.kept.join(", ") }),
                type: undo.kept.length === 0 ? "info" : "warning",
                duration: 6000,
              }),
            )
            .catch((e) => toast.addToast({ message: String(e), type: "error", duration: 6000 }));
        },
      },
    ],
  });
  return out;
}

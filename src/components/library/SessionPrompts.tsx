// ─── Prompts for the session in front (⌘J, the Prompts button) ─────────
//
// The palette in its "session" form: a pick goes into the active session
// (a terminal gets a paste with no Enter, an Agent view its message box),
// "Insert and send" adds the Enter, and with no session the text is copied.
// What was selected in the terminal when ⌘J was pressed goes into the
// prompt's first blank.

import { useCallback, useMemo, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../../i18n/I18nProvider";
import { useComposer, useSession } from "../../state/SessionContext";
import { useOverlay } from "../../state/overlays";
import { useToastStore } from "../../hooks/useToastStore";
import { getTerminal } from "../../terminal/TerminalPool";
import { exportPromptBundle, importPromptBundle } from "../../api/promptBundle";
import { validateBundle } from "../../lib/promptBundle";
import { pasteFold } from "../../library/delivery";
import { openLibraryAt } from "../../library/libraryFocus";
import { placeInSession, sessionDeps } from "../../library/placeInSession";
import { needsLeadLine } from "../../library/promptPicker";
import { addMyPrompts, fromBundle, loadMyPrompts, toBundle } from "../../library/myPrompts";
import { PromptPicker, type PickerDelivery } from "./PromptPicker";

export function SessionPrompts({ sessionId, onClose }: { sessionId: string | null; onClose: () => void }) {
  const { t } = useI18n();
  const { state, dispatch } = useSession();
  const toasts = useToastStore();
  const session = sessionId ? state.sessions[sessionId] : null;
  const composer = useComposer(sessionId ?? "");
  useOverlay("prompts", true, onClose);

  // Taken once, as the palette opens: the terminal keeps its selection while the palette covers it.
  const [prefill] = useState(() => {
    if (!sessionId || session?.mode === "agent") return "";
    try {
      return getTerminal(sessionId)?.getSelection()?.trim() ?? "";
    } catch {
      return "";
    }
  });

  const toast = useCallback(
    (message: string, type: "info" | "success" | "warning" | "error" = "info") => toasts.addToast({ message, type, duration: type === "error" ? 6000 : 4000 }),
    [toasts],
  );

  const agentId = session?.ai_provider ?? session?.detected_agent?.provider ?? null;
  const delivery: PickerDelivery | undefined = useMemo(() => {
    if (!session) return undefined;
    return {
      label: session.label,
      canSend: session.mode !== "agent",
      place: (text, { title, send }) =>
        placeInSession(
          { id: session.id, mode: session.mode === "agent" ? "agent" : "terminal", draft: composer.draft },
          text,
          sessionDeps((id, draft) => dispatch({ type: "SET_COMPOSER_DRAFT", sessionId: id, draft })),
          { send, lead: session.mode !== "agent" && needsLeadLine(text, pasteFold(agentId)) ? t("library.prompts.leadLine", { title }) : null },
        ),
    };
  }, [session, composer.draft, dispatch, agentId, t]);

  const onImport = useCallback(async () => {
    try {
      const path = await open({ filters: [{ name: "Hermes Prompts", extensions: ["hermes-prompts"] }], multiple: false, directory: false });
      if (typeof path !== "string") return;
      const raw = await importPromptBundle(path);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        toast(t("library.prompts.importFailed", { error: "JSON" }), "error");
        return;
      }
      const v = validateBundle(parsed);
      if (!v.valid) {
        toast(t("library.prompts.importFailed", { error: v.error }), "error");
        return;
      }
      const { legacyTemplateText } = await import("../../library/legacy");
      const text = await legacyTemplateText(v.bundle.templates ?? [], v.bundle.roles ?? [], v.bundle.styles ?? []);
      const folder = v.bundle._hermes_bundle_name ?? path.split(/[\\/]/).pop()?.replace(/\.hermes-prompts$/i, "");
      const { added, skipped } = fromBundle(v.bundle, await loadMyPrompts(), (tpl) => text.get(tpl.id) ?? "", folder);
      await addMyPrompts(added);
      if (added.length === 0) toast(t("library.prompts.nothingToImport"), "info");
      else if (skipped > 0) toast(t("library.prompts.importedSkipped", { count: added.length, skipped }), "success");
      else toast(t("library.prompts.imported", { count: added.length }), "success");
    } catch (e) {
      toast(t("library.prompts.importFailed", { error: String(e) }), "error");
    }
  }, [t, toast]);

  const onExport = useCallback(async () => {
    try {
      const list = await loadMyPrompts();
      if (list.length === 0) return;
      const path = await save({ defaultPath: "my-prompts.hermes-prompts", filters: [{ name: "Hermes Prompts", extensions: ["hermes-prompts"] }] });
      if (!path) return;
      const version = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";
      await exportPromptBundle(path, JSON.stringify(toBundle(list, version), null, 2));
      toast(t("library.prompts.exported", { count: list.length }), "success");
    } catch (e) {
      toast(t("library.prompts.toastFailed", { error: String(e) }), "error");
    }
  }, [t, toast]);

  return (
    <PromptPicker
      context="session"
      delivery={delivery}
      prefill={prefill}
      projectPath={session?.working_directory || null}
      libraryContext={{ projectPath: session?.working_directory || null, activeWork: null }}
      onClose={onClose}
      onOpenLibrary={(id, install) => {
        onClose();
        openLibraryAt(id, install);
      }}
      onImport={() => void onImport()}
      onExport={() => void onExport()}
      toast={toast}
    />
  );
}

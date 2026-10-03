// ─── Prompt library commands (src-tauri/src/library/mod.rs) ───────────
//
// Nothing here returns the whole catalog: search is one page of at most 50
// rows, shelves at most 12 cards each, and a body only for the open entry.
// Every personal signal in a request is used on the device and never sent.

import { invoke } from "@tauri-apps/api/core";
import type {
  ApplySummary,
  CompiledFileForInstall,
  EntryDetail,
  InstallPlan,
  InstallResult,
  ItemState,
  Labeled,
  LibraryContext,
  LibraryHit,
  LibraryProfile,
  LibraryStatus,
  ProjectInstalls,
  SearchPage,
  SearchRequest,
  Shelves,
  UpdateOutcome,
} from "./types";

export const LIBRARY_UPDATED_EVENT = "library-updated";

export const libraryStatus = () => invoke<LibraryStatus>("library_status");

export const librarySearch = (request: SearchRequest, context?: LibraryContext) =>
  invoke<SearchPage>("library_search", { request, context: context ?? null });

export const libraryShelves = (context: LibraryContext) => invoke<Shelves>("library_shelves", { context });

export const libraryGet = (id: string) => invoke<EntryDetail>("library_get", { id });

export const libraryHits = (ids: string[], context?: LibraryContext) =>
  invoke<LibraryHit[]>("library_hits", { ids, context: context ?? null });

export const libraryResolve = (ids: string[]) => invoke<Record<string, string>>("library_resolve", { ids });

export const libraryVocab = (facets: string[]) =>
  invoke<{ facets: Record<string, Labeled[]> }>("library_vocab", { facets });

export const libraryRecordUse = (id: string) => invoke<void>("library_record_use", { id });

export const librarySetItem = (id: string, flags: { pinned?: boolean; favorite?: boolean; hidden?: boolean }) =>
  invoke<void>("library_set_item", { id, pinned: flags.pinned ?? null, favorite: flags.favorite ?? null, hidden: flags.hidden ?? null });

export const libraryItemStates = () => invoke<ItemState[]>("library_item_states");

export const libraryGetProfile = () => invoke<LibraryProfile>("library_get_profile");

export const librarySetProfile = (profile: LibraryProfile) => invoke<void>("library_set_profile", { profile });

export const libraryResetPersonalisation = () => invoke<void>("library_reset_personalisation");

export const libraryCheckUpdate = (apply?: boolean) => invoke<UpdateOutcome>("library_check_update", { apply: apply ?? null });

export const libraryRollback = () => invoke<ApplySummary>("library_rollback");

export const libraryInstallPreview = (projectPath: string, files: CompiledFileForInstall[]) =>
  invoke<InstallPlan>("library_install_preview", { projectPath, files });

export const libraryInstallApply = (projectPath: string, agentId: string, files: CompiledFileForInstall[]) =>
  invoke<InstallResult>("library_install_apply", { projectPath, agentId, files });

export const libraryInstalls = (projectPath?: string | null) =>
  invoke<ProjectInstalls>("library_installs", { projectPath: projectPath ?? null });

export const libraryUninstall = (projectPath: string, itemId: string, target: string, agentId: string) =>
  invoke<string[]>("library_uninstall", { projectPath, itemId, target, agentId });

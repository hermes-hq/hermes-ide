import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RegistryPlugin, ChangelogEntry } from "../plugins/types";
import { REGISTRY_URL } from "../plugins/constants";
import { hasUpdate } from "../plugins/semver";
import { getSetting, setSetting } from "../api/settings";
import { downloadAndInstallPlugin } from "../plugins/pluginInstaller";
import { PluginLoader } from "../plugins/PluginLoader";
import type { PluginRuntime } from "../plugins/PluginRuntime";

// ─── Types ───────────────────────────────────────────────

export interface PluginUpdateInfo {
  id: string;
  name: string;
  currentVersion: string;
  newVersion: string;
  downloadUrl: string;
  changelog?: ChangelogEntry[];
  icon?: string;
}

export interface PluginUpdateResult {
  id: string;
  name: string;
  success: boolean;
}

export interface PluginUpdateState {
  updatesAvailable: PluginUpdateInfo[];
  checking: boolean;
  dismissed: boolean;
  lastChecked: string | null;
  updateResults: PluginUpdateResult[];
  autoUpdated: boolean;
}

export interface PluginUpdateActions {
  checkNow: () => Promise<void>;
  dismissAll: () => void;
  ignoreVersion: (pluginId: string, version: string) => Promise<void>;
  updatePlugin: (plugin: PluginUpdateInfo) => Promise<void>;
  updateAll: () => Promise<void>;
  clearResults: () => void;
}

export type PluginUpdater = PluginUpdateState & PluginUpdateActions;

// ─── Constants ───────────────────────────────────────────

const CHECK_DELAY_MS = 5_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

// ─── Helpers (exported for testing) ──────────────────────

export function shouldCheck(
  frequency: string,
  lastCheckISO: string | null,
  now: number = Date.now(),
): boolean {
  if (frequency === "never") return false;
  if (frequency === "startup") return true;
  if (!lastCheckISO) return true;

  const last = new Date(lastCheckISO).getTime();
  if (isNaN(last)) return true;

  const elapsed = now - last;
  if (frequency === "daily") return elapsed >= MS_PER_DAY;
  if (frequency === "weekly") return elapsed >= MS_PER_WEEK;

  return true;
}

export function filterIgnored(
  updates: PluginUpdateInfo[],
  ignoredJson: string,
): PluginUpdateInfo[] {
  let ignored: Record<string, string> = {};
  try {
    ignored = JSON.parse(ignoredJson);
  } catch {
    // Invalid JSON — treat as no ignores
  }
  return updates.filter((u) => ignored[u.id] !== u.newVersion);
}

export function findUpdates(
  installedPlugins: { id: string; version: string; name: string }[],
  registryPlugins: RegistryPlugin[],
): PluginUpdateInfo[] {
  const installedMap = new Map(
    installedPlugins.map((p) => [p.id, p]),
  );

  const updates: PluginUpdateInfo[] = [];
  for (const rp of registryPlugins) {
    const installed = installedMap.get(rp.id);
    if (installed && hasUpdate(installed.version, rp.version)) {
      updates.push({
        id: rp.id,
        name: rp.name,
        currentVersion: installed.version,
        newVersion: rp.version,
        downloadUrl: rp.downloadUrl,
        changelog: rp.changelog,
        icon: rp.icon,
      });
    }
  }
  return updates;
}

// ─── Hook ────────────────────────────────────────────────

const INITIAL_STATE: PluginUpdateState = {
  updatesAvailable: [],
  checking: false,
  dismissed: false,
  lastChecked: null,
  updateResults: [],
  autoUpdated: false,
};

export function usePluginUpdateChecker(
  runtime?: PluginRuntime,
): PluginUpdater {
  const [state, setState] = useState<PluginUpdateState>(INITIAL_STATE);
  const checkingRef = useRef(false);

  const hotLoadPlugins = useCallback(async () => {
    if (!runtime) return;
    const loader = new PluginLoader(runtime);
    await loader.loadAllPlugins();
    await runtime.activateStartupPlugins();
  }, [runtime]);

  const doCheck = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setState((s) => ({ ...s, checking: true }));

    try {
      // Fetch registry + installed plugins in parallel
      const [registryJson, installedRaw] = await Promise.all([
        invoke<string>("fetch_plugin_registry", { url: REGISTRY_URL }),
        invoke<{ id: string; dir_name: string; manifest_json: string }[]>(
          "list_installed_plugins",
        ),
      ]);

      const registryData = JSON.parse(registryJson);
      const registryPlugins: RegistryPlugin[] = registryData.plugins ?? [];

      const installedPlugins = installedRaw
        .map((p) => {
          try {
            const manifest = JSON.parse(p.manifest_json);
            return { id: manifest.id as string, version: manifest.version as string, name: manifest.name as string };
          } catch {
            return null;
          }
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);

      // Find updates
      let updates = findUpdates(installedPlugins, registryPlugins);

      // Filter ignored versions
      const ignoredJson = await getSetting("plugin_ignored_updates");
      if (ignoredJson) {
        updates = filterIgnored(updates, ignoredJson);
      }

      // Save last check timestamp
      const now = new Date().toISOString();
      await setSetting("plugin_last_update_check", now);

      // Check auto-update preference
      const autoUpdate = await getSetting("plugin_auto_update");

      if (autoUpdate === "true" && updates.length > 0) {
        // Auto-update silently
        const results: PluginUpdateResult[] = [];
        for (const u of updates) {
          try {
            await downloadAndInstallPlugin(u.downloadUrl);
            results.push({ id: u.id, name: u.name, success: true });
          } catch {
            results.push({ id: u.id, name: u.name, success: false });
          }
        }
        await hotLoadPlugins();
        setState({
          updatesAvailable: [],
          checking: false,
          dismissed: false,
          lastChecked: now,
          updateResults: results,
          autoUpdated: true,
        });
      } else {
        setState({
          updatesAvailable: updates,
          checking: false,
          dismissed: false,
          lastChecked: now,
          updateResults: [],
          autoUpdated: false,
        });
      }
    } catch {
      // Silent failure — registry unreachable, etc.
      setState((s) => ({ ...s, checking: false }));
    } finally {
      checkingRef.current = false;
    }
  }, [hotLoadPlugins]);

  // Background check on mount
  useEffect(() => {
    let cancelled = false;

    const timer = setTimeout(async () => {
      if (cancelled) return;

      const [frequency, lastCheck] = await Promise.all([
        getSetting("plugin_update_check").catch(() => ""),
        getSetting("plugin_last_update_check").catch(() => ""),
      ]);

      const freq = frequency || "startup";
      if (shouldCheck(freq, lastCheck || null)) {
        doCheck();
      }
    }, CHECK_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [doCheck]);

  const checkNow = useCallback(async () => {
    await doCheck();
  }, [doCheck]);

  const dismissAll = useCallback(() => {
    setState((s) => ({ ...s, dismissed: true }));
  }, []);

  const ignoreVersion = useCallback(async (pluginId: string, version: string) => {
    // Update persisted ignore map
    const currentJson = await getSetting("plugin_ignored_updates").catch(() => "");
    let ignored: Record<string, string> = {};
    try {
      ignored = JSON.parse(currentJson || "{}");
    } catch {
      // reset
    }
    ignored[pluginId] = version;
    await setSetting("plugin_ignored_updates", JSON.stringify(ignored));

    // Remove from displayed list
    setState((s) => {
      const remaining = s.updatesAvailable.filter(
        (u) => !(u.id === pluginId && u.newVersion === version),
      );
      return {
        ...s,
        updatesAvailable: remaining,
        dismissed: remaining.length === 0 ? true : s.dismissed,
      };
    });
  }, []);

  const updatePlugin = useCallback(async (plugin: PluginUpdateInfo) => {
    try {
      await downloadAndInstallPlugin(plugin.downloadUrl);
      await hotLoadPlugins();
      setState((s) => ({
        ...s,
        updatesAvailable: s.updatesAvailable.filter((u) => u.id !== plugin.id),
        updateResults: [...s.updateResults, { id: plugin.id, name: plugin.name, success: true }],
      }));
    } catch {
      setState((s) => ({
        ...s,
        updateResults: [...s.updateResults, { id: plugin.id, name: plugin.name, success: false }],
      }));
    }
  }, [hotLoadPlugins]);

  const updateAll = useCallback(async () => {
    const plugins = [...state.updatesAvailable];
    const results: PluginUpdateResult[] = [];

    for (const plugin of plugins) {
      try {
        await downloadAndInstallPlugin(plugin.downloadUrl);
        results.push({ id: plugin.id, name: plugin.name, success: true });
      } catch {
        results.push({ id: plugin.id, name: plugin.name, success: false });
      }
    }

    await hotLoadPlugins();

    setState((s) => ({
      ...s,
      updatesAvailable: [],
      updateResults: results,
      autoUpdated: false,
    }));
  }, [state.updatesAvailable, hotLoadPlugins]);

  const clearResults = useCallback(() => {
    setState((s) => ({
      ...s,
      updateResults: [],
      autoUpdated: false,
      dismissed: true,
    }));
  }, []);

  return {
    ...state,
    checkNow,
    dismissAll,
    ignoreVersion,
    updatePlugin,
    updateAll,
    clearResults,
  };
}

// @vitest-environment jsdom
/**
 * The launcher's project menu, driven through the whole launcher (⌘N):
 *   - with no search: Recent (how often × how lately, top 5) then All
 *     projects A–Z, missing folders last and struck through;
 *   - the search: fuzzy on the name (matched letters marked), then the path;
 *     a typed path offers "Use this folder"; no match says so;
 *   - keys: arrows + Enter pick, ⌘↵ still launches, the first Esc clears,
 *     the second closes; ⌘P opens the menu on its search;
 *   - remove from list: asked in the row, Cancel / Esc keep it, Remove calls
 *     delete_project, the launcher's own project falls back;
 *   - no projects, projects that cannot be read (Retry), New project….
 * Every path and name here is made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { DoctorRow } from "../api/doctor";
import type { RepoProbe } from "../api/launcher";
import type { FakeCapabilityCommands } from "./fakes/capabilityCommands";

interface FixtureProject {
  id: string;
  name: string;
  path: string;
  path_exists: boolean;
  session_count: number;
  last_opened_at: string | null;
}

const h = vi.hoisted(() => ({
  doctor: [] as DoctorRow[],
  probe: new Map<string, RepoProbe>(),
  settings: new Map<string, string>(),
  projects: [] as FixtureProject[],
  projectsFail: false,
  deleteFail: null as string | null,
  deleted: [] as string[],
  cap: null as unknown as FakeCapabilityCommands,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "agent_doctor") return h.doctor;
    if (cmd === "task_repo_probe") {
      return h.probe.get(String(args.path)) ?? { git_root: null, branch_exists: false, local_branches: [], worktree_toml: null, current_branch: null };
    }
    if (cmd === "git_disk_status") return { free_bytes: 100 * 1024 ** 3, required_bytes: 10 * 1024 ** 3, below_threshold: false };
    if (cmd === "get_projects_ordered") {
      if (h.projectsFail) throw new Error("database is locked");
      return h.projects;
    }
    if (cmd === "delete_project") {
      if (h.deleteFail) throw new Error(h.deleteFail);
      h.deleted.push(String(args.id));
      h.projects = h.projects.filter((p) => p.id !== args.id);
      return null;
    }
    const answer = h.cap.handle(cmd, args ?? {});
    if (answer) return answer.value;
    throw new Error(`command ${cmd} not found`);
  }),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/Users/test") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("../api/settings", () => ({
  getSetting: vi.fn(async (k: string) => h.settings.get(k) ?? ""),
  setSetting: vi.fn(async (k: string, v: string) => {
    h.settings.set(k, v);
  }),
  getSettings: vi.fn(async () => Object.fromEntries(h.settings)),
}));

import { TaskLauncher, type TaskLaunchRequest } from "../components/TaskLauncher";
import { I18nProvider } from "../i18n/I18nProvider";
import { __resetDoctorForTest } from "../launcher/doctorStore";
import { fakeCapabilityCommands } from "./fakes/capabilityCommands";
import { __resetOffersForTest, clearLauncherDraft, setPendingSuggestion } from "../launcher/draft";
import { isMac } from "../utils/platform";

vi.setConfig({ testTimeout: 20_000 });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** SQLite's datetime('now') form (UTC), `ago` ms before now. */
const sqlAgo = (ago: number) => new Date(Date.now() - ago).toISOString().replace("T", " ").slice(0, 19);
const project = (id: string, name: string, path: string, sessions: number, ago: number | null, exists = true): FixtureProject => ({
  id,
  name,
  path,
  path_exists: exists,
  session_count: sessions,
  last_opened_at: ago === null ? null : sqlAgo(ago),
});

const ATLAS = "/Users/test/code/atlas";
const BEACON = "/Users/test/code/beacon";
const COBALT = "/Users/test/work/cobalt";
const GONE = "/Users/test/old/gone-app";

function doctorRow(id: string, name: string): DoctorRow {
  return { id, name, installed: true, version: "1.2.3", min_version: null, version_ok: null, signed_in: "yes", signals: "exact", resume: true, retired: false, retired_note: null, beta: false };
}
const repoProbe = (root: string): RepoProbe => ({ git_root: root, branch_exists: false, local_branches: ["main"], worktree_toml: null, current_branch: "main" }) as RepoProbe;

beforeEach(() => {
  h.doctor = [doctorRow("claude", "Claude Code")];
  h.probe = new Map([ATLAS, BEACON, COBALT].map((p) => [p, repoProbe(p)]));
  h.settings = new Map();
  // The backend's order: most used first, missing folders last.
  h.projects = [
    project("p-atlas", "atlas", ATLAS, 20, HOUR),
    project("p-beacon", "beacon", BEACON, 10, 2 * DAY),
    project("p-cobalt", "cobalt", COBALT, 3, 10 * DAY),
    project("p-delta", "delta", "/Users/test/code/delta", 2, 20 * DAY),
    project("p-ember", "ember", "/Users/test/code/ember", 1, 40 * DAY),
    project("p-fjord", "fjord", "/Users/test/notes/fjord", 1, 90 * DAY),
    project("p-zephyr", "zephyr-docs", "/Users/test/code/zephyr/docs", 0, null),
    project("p-gone", "gone-app", GONE, 5, DAY, false),
  ];
  h.projectsFail = false;
  h.deleteFail = null;
  h.deleted = [];
  __resetDoctorForTest();
  h.cap = fakeCapabilityCommands(() => h.doctor);
  clearLauncherDraft();
  setPendingSuggestion(null);
  __resetOffersForTest();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });

async function openLauncher(defaultRepo: string | null = ATLAS) {
  const onLaunch = vi.fn(async (_req: TaskLaunchRequest) => true);
  const onClose = vi.fn();
  render(
    <I18nProvider>
      <TaskLauncher defaultRepo={defaultRepo} onLaunch={onLaunch} onSignIn={vi.fn()} onClose={onClose} />
    </I18nProvider>,
  );
  await settle();
  await settle();
  return { onLaunch, onClose };
}

const modKey = isMac ? { metaKey: true } : { ctrlKey: true };
const task = () => screen.getByPlaceholderText(/Describe the task/) as HTMLTextAreaElement;
const chip = () => document.querySelector('[data-chip="project"]') as HTMLButtonElement;
const menu = () => document.querySelector('.task-launcher-menu[data-menu="project"]') as HTMLElement | null;
const search = () => screen.getByRole("combobox", { name: "Search projects or type a path…" }) as HTMLInputElement;
const rowPaths = () => [...document.querySelectorAll(".task-launcher-menu [data-project-path]")].map((r) => r.getAttribute("data-project-path"));
const rowNames = () => [...document.querySelectorAll(".task-launcher-menu [data-project-path] .launcher-pm-name")].map((r) => r.textContent);
const row = (path: string) => document.querySelector(`.task-launcher-menu [data-project-path="${path}"]`) as HTMLElement;
const highlighted = () => document.getElementById(search().getAttribute("aria-activedescendant") ?? "") as HTMLElement | null;

async function openMenu() {
  fireEvent.click(chip());
  await settle();
}
async function typeSearch(value: string) {
  fireEvent.change(search(), { target: { value } });
  await settle();
}

describe("the project menu with no search", () => {
  it("shows Recent (top 5 by how often × how lately), then All projects A–Z, missing folders last", async () => {
    await openLauncher();
    await openMenu();
    expect(document.activeElement).toBe(search());
    const groups = [...document.querySelectorAll(".launcher-pm-group")];
    expect(groups.map((g) => g.querySelector(".launcher-pm-section")?.textContent)).toEqual(["Recent", "All projects"]);
    expect(within(groups[0] as HTMLElement).getAllByRole("option").map((o) => o.querySelector(".launcher-pm-name")?.textContent)).toEqual(["atlas", "beacon", "cobalt", "delta", "ember"]);
    expect(rowNames()).toEqual(["atlas", "beacon", "cobalt", "delta", "ember", "fjord", "zephyr-docs", "gone-app"]);

    // One line: the name, the parent folder with ~ for home (the full path as the title), when it was last used.
    const atlas = row(ATLAS);
    expect(atlas.querySelector(".launcher-pm-path")).toHaveTextContent("~/code");
    expect(atlas).toHaveAttribute("title", ATLAS);
    expect(atlas.querySelector(".launcher-pm-ago")).toHaveTextContent("1h");
    expect(row(BEACON).querySelector(".launcher-pm-ago")).toHaveTextContent("2d");
    expect(row(COBALT).querySelector(".launcher-pm-ago")).toHaveTextContent("1w");
    expect(row("/Users/test/notes/fjord").querySelector(".launcher-pm-ago")).toHaveTextContent("3mo");
    // The current project carries the rail and starts highlighted.
    expect(atlas).toHaveAttribute("data-current");
    expect(highlighted()).toBe(atlas);
    // A folder that is gone: last, struck through, said so.
    const gone = row(GONE);
    expect(gone).toHaveClass("launcher-pm-missing");
    expect(gone.querySelector(".launcher-pm-ago")).toHaveTextContent("Folder not found");
    // The actions stay under the list; the typed path is still there.
    expect(screen.getByRole("option", { name: "Open folder…" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "New project…" })).toHaveClass("task-launcher-new-folder");
    expect(document.querySelector(".task-launcher-repo")).not.toBeNull();
    expect(document.querySelector(".launcher-pm-hints")).toHaveTextContent("esc close");
  });

  it("says when there are no projects yet, and keeps the actions", async () => {
    h.projects = [];
    await openLauncher();
    await openMenu();
    expect(menu()).toHaveTextContent("No projects yet");
    expect(screen.getByRole("option", { name: "Open folder…" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "New project…" })).toBeInTheDocument();
  });

  it("says when the projects cannot be read, and Retry reads them again", async () => {
    h.projectsFail = true;
    await openLauncher();
    await openMenu();
    expect(menu()).toHaveTextContent("Couldn't load projects");
    expect(rowPaths()).toEqual([]);
    h.projectsFail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(menu()).not.toHaveTextContent("Couldn't load projects");
    expect(rowPaths()).toContain(BEACON);
  });
});

describe("searching", () => {
  it("ranks by name first and marks the matched letters, then matches the path", async () => {
    await openLauncher();
    await openMenu();
    await typeSearch("bea");
    expect(rowNames()[0]).toBe("beacon");
    expect([...row(BEACON).querySelectorAll(".launcher-pm-hit")].map((m) => m.textContent)).toEqual(["bea"]);
    expect(highlighted()).toBe(row(BEACON));
    expect(document.querySelector(".launcher-pm-section")).toBeNull();
    expect(document.querySelector(".launcher-pm-hints")).toHaveTextContent("esc clear");

    // "work" is in no name: cobalt matches on its path (~/work/cobalt), nothing marked.
    await typeSearch("work");
    expect(rowNames()).toEqual(["cobalt"]);
    expect(row(COBALT).querySelector(".launcher-pm-hit")).toBeNull();

    // A name match ranks above a path-only match.
    await typeSearch("docs");
    expect(rowNames()[0]).toBe("zephyr-docs");
  });

  it("says when nothing matches", async () => {
    await openLauncher();
    await openMenu();
    await typeSearch("qqq");
    expect(rowPaths()).toEqual([]);
    expect(menu()).toHaveTextContent("No project matches “qqq”.");
    expect(screen.getByRole("option", { name: "Open folder…" })).toBeInTheDocument();
  });

  it("a typed path offers Use this folder first; Enter sets it as the project", async () => {
    await openLauncher();
    await openMenu();
    await typeSearch("/Users/test/code/");
    const first = screen.getAllByRole("option")[0];
    expect(first).toHaveClass("launcher-pm-use");
    expect(first).toHaveTextContent("Use this folder/Users/test/code/");
    expect(rowPaths()).toEqual(expect.arrayContaining([ATLAS, BEACON]));
    expect(rowPaths()).not.toContain(COBALT);

    await typeSearch("~/scratch/new-thing");
    expect(highlighted()).toHaveClass("launcher-pm-use");
    fireEvent.keyDown(search(), { key: "Enter" });
    await settle();
    expect(menu()).toBeNull();
    expect(chip()).toHaveTextContent("new-thing");
    expect(document.activeElement).toBe(task());
  });
});

describe("keys in the project menu", () => {
  it("arrows move the highlight and Enter picks: the menu closes and the task field has the keyboard", async () => {
    const { onLaunch } = await openLauncher();
    await openMenu();
    expect(highlighted()).toBe(row(ATLAS));
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(highlighted()).toBe(row(BEACON));
    expect(row(BEACON)).toHaveAttribute("data-highlighted");
    fireEvent.keyDown(search(), { key: "ArrowUp" });
    expect(highlighted()).toBe(row(ATLAS));
    fireEvent.keyDown(search(), { key: "End" });
    expect(highlighted()).toHaveTextContent("New project…");
    fireEvent.keyDown(search(), { key: "Home" });
    expect(highlighted()).toBe(row(ATLAS));
    // Ten rows at a time, stopping at the ends (8 projects + 2 actions here).
    fireEvent.keyDown(search(), { key: "PageDown" });
    expect(highlighted()).toHaveTextContent("New project…");
    fireEvent.keyDown(search(), { key: "PageUp" });
    expect(highlighted()).toBe(row(ATLAS));
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(highlighted()).toBe(row(BEACON));
    fireEvent.keyDown(search(), { key: "Enter" });
    await settle();
    expect(menu()).toBeNull();
    expect(chip()).toHaveTextContent("beacon");
    expect(document.activeElement).toBe(task());
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("⌘↵ in the search launches the task", async () => {
    const { onLaunch } = await openLauncher();
    fireEvent.change(task(), { target: { value: "Fix the flaky test" } });
    await settle();
    await openMenu();
    fireEvent.keyDown(search(), { key: "Enter", ...modKey });
    await settle();
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch.mock.calls[0][0].repoRoot).toBe(ATLAS);
  });

  it("the first Esc clears the search, the second closes the menu (not the sheet)", async () => {
    const { onClose } = await openLauncher();
    await openMenu();
    await typeSearch("bea");
    fireEvent.keyDown(search(), { key: "Escape" });
    await settle();
    expect(menu()).not.toBeNull();
    expect(search().value).toBe("");
    expect(rowPaths()).toHaveLength(8);
    fireEvent.keyDown(search(), { key: "Escape" });
    await settle();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(chip());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("⌘P opens the project menu on its search, also from the app's menu key", async () => {
    await openLauncher();
    expect(menu()).toBeNull();
    fireEvent.keyDown(task(), { key: "p", ...modKey });
    await settle();
    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(search());
    fireEvent.keyDown(search(), { key: "Escape" });
    await settle();
    expect(menu()).toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent("hermes:launcher-project"));
    });
    await settle();
    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(search());
  });

  it("New project… opens the form in place of the list; Esc goes back to the list", async () => {
    await openLauncher();
    await openMenu();
    fireEvent.click(screen.getByRole("option", { name: "New project…" }));
    await settle();
    expect(document.querySelector(".task-launcher-menu .new-folder-form")).not.toBeNull();
    expect(screen.queryByRole("combobox", { name: "Search projects or type a path…" })).toBeNull();
    fireEvent.keyDown(document.querySelector(".new-folder-name") as HTMLElement, { key: "Escape" });
    await settle();
    expect(document.querySelector(".new-folder-form")).toBeNull();
    expect(document.activeElement).toBe(search());
  });
});

describe("remove from list", () => {
  it("asks in the row; Cancel keeps the project", async () => {
    await openLauncher();
    await openMenu();
    fireEvent.click(row(BEACON).querySelector(".launcher-pm-remove") as HTMLElement);
    await settle();
    expect(row(BEACON)).toHaveTextContent("Remove beacon from the list? Files stay on disk.");
    fireEvent.click(within(row(BEACON)).getByRole("button", { name: "Cancel" }));
    await settle();
    expect(row(BEACON)).not.toHaveClass("launcher-pm-confirm");
    expect(h.deleted).toEqual([]);
    expect(document.activeElement).toBe(search());
  });

  it("Remove calls delete_project and drops the row; the files are not the menu's business", async () => {
    await openLauncher();
    await openMenu();
    fireEvent.click(row(BEACON).querySelector(".launcher-pm-remove") as HTMLElement);
    await settle();
    fireEvent.click(within(row(BEACON)).getByRole("button", { name: "Remove" }));
    await settle();
    expect(h.deleted).toEqual(["p-beacon"]);
    expect(rowPaths()).not.toContain(BEACON);
    expect(menu()).not.toBeNull();
    expect(chip()).toHaveTextContent("atlas");
  });

  it("from the keyboard: Backspace on an empty search asks, Esc cancels first; typed text is still edited", async () => {
    await openLauncher();
    await openMenu();
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "Backspace" });
    await settle();
    expect(row(BEACON)).toHaveClass("launcher-pm-confirm");
    expect(document.activeElement).toHaveTextContent("Remove");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await settle();
    expect(row(BEACON)).not.toHaveClass("launcher-pm-confirm");
    expect(menu()).not.toBeNull();
    // With text in the search, Backspace edits it and asks nothing.
    await typeSearch("bea");
    const prevented = !fireEvent.keyDown(search(), { key: "Backspace" });
    expect(prevented).toBe(false);
    expect(document.querySelector(".launcher-pm-confirm")).toBeNull();
    // Delete works the same as Backspace.
    await typeSearch("");
    fireEvent.keyDown(search(), { key: "Delete" });
    await settle();
    expect(row(ATLAS)).toHaveClass("launcher-pm-confirm");
  });

  it("a missing folder offers removal when chosen", async () => {
    await openLauncher();
    await openMenu();
    fireEvent.click(row(GONE));
    await settle();
    expect(row(GONE)).toHaveTextContent("Remove gone-app from the list? Files stay on disk.");
    fireEvent.click(within(row(GONE)).getByRole("button", { name: "Remove" }));
    await settle();
    expect(h.deleted).toEqual(["p-gone"]);
    expect(rowPaths()).not.toContain(GONE);
  });

  it("says why it could not remove, in the row", async () => {
    h.deleteFail = "project is busy";
    await openLauncher();
    await openMenu();
    fireEvent.click(row(COBALT).querySelector(".launcher-pm-remove") as HTMLElement);
    await settle();
    fireEvent.click(within(row(COBALT)).getByRole("button", { name: "Remove" }));
    await settle();
    expect(within(row(COBALT)).getByRole("alert")).toHaveTextContent("Couldn't remove it: project is busy");
    expect(rowPaths()).toContain(COBALT);
  });

  it("removing the launcher's own project falls back to the next starting project (never a missing one)", async () => {
    await openLauncher(null);
    expect(chip()).toHaveTextContent("atlas");
    await openMenu();
    fireEvent.click(row(ATLAS).querySelector(".launcher-pm-remove") as HTMLElement);
    await settle();
    fireEvent.click(within(row(ATLAS)).getByRole("button", { name: "Remove" }));
    await settle();
    expect(h.deleted).toEqual(["p-atlas"]);
    // gone-app has more sessions than cobalt but its folder is missing; beacon is next.
    expect(chip()).toHaveTextContent("beacon");
    expect(row(BEACON)).toHaveAttribute("data-current");
  });
});

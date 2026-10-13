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
 *   - no projects, projects that cannot be read (Retry), New project…;
 *   - extra folders: the checkbox / ⇧↵ adds one (In this task on top), ↵ on
 *     one makes it the main project, ⌘⌫ removes it, the rows that cannot be
 *     one say why, at most 5, an agent that works in one folder has none;
 *     the chip says +N, the Also line removes, and the launch carries them.
 * Every path and name here is made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { DoctorRow } from "../api/doctor";
import type { RepoProbe } from "../api/launcher";
import type { FakeCapabilityCommands } from "./fakes/capabilityCommands";
import type { CreateSessionOpts, SessionData } from "../types/session";

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
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/fixture-home") }));
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

const ATLAS = "/fixture-home/code/atlas";
const BEACON = "/fixture-home/code/beacon";
const COBALT = "/fixture-home/work/cobalt";
const GONE = "/fixture-home/old/gone-app";

function doctorRow(id: string, name: string): DoctorRow {
  return { id, name, installed: true, version: "1.2.3", min_version: null, version_ok: null, signed_in: "yes", signals: "exact", resume: true, retired: false, retired_note: null, beta: false };
}
const repoProbe = (root: string, branch = "main", dirty = 0): RepoProbe =>
  ({ git_root: root, branch_exists: false, local_branches: [branch], worktree_toml: null, current_branch: branch, dirty_count: dirty }) as RepoProbe;

beforeEach(() => {
  h.doctor = [doctorRow("claude", "Claude Code")];
  h.probe = new Map([ATLAS, BEACON, COBALT].map((p) => [p, repoProbe(p)]));
  h.settings = new Map();
  // The backend's order: most used first, missing folders last.
  h.projects = [
    project("p-atlas", "atlas", ATLAS, 20, HOUR),
    project("p-beacon", "beacon", BEACON, 10, 2 * DAY),
    project("p-cobalt", "cobalt", COBALT, 3, 10 * DAY),
    project("p-delta", "delta", "/fixture-home/code/delta", 2, 20 * DAY),
    project("p-ember", "ember", "/fixture-home/code/ember", 1, 40 * DAY),
    project("p-fjord", "fjord", "/fixture-home/notes/fjord", 1, 90 * DAY),
    project("p-zephyr", "zephyr-docs", "/fixture-home/code/zephyr/docs", 0, null),
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
    // The launcher's project sits on top, under In this task (not repeated in Recent).
    expect(groups.map((g) => g.querySelector(".launcher-pm-section")?.textContent)).toEqual(["In this task", "Recent", "All projects"]);
    const names = (g: Element) => within(g as HTMLElement).getAllByRole("option").map((o) => o.querySelector(".launcher-pm-name")?.textContent);
    expect(names(groups[0])).toEqual(["atlas"]);
    expect(groups[0].querySelector(".launcher-pm-main")).toHaveTextContent("main");
    expect(names(groups[1])).toEqual(["beacon", "cobalt", "delta", "ember", "fjord"]);
    expect(rowNames()).toEqual(["atlas", "beacon", "cobalt", "delta", "ember", "fjord", "zephyr-docs", "gone-app"]);

    // One line: the name, the parent folder with ~ for home (the full path as the title), when it was last used.
    const atlas = row(ATLAS);
    expect(atlas.querySelector(".launcher-pm-path")).toHaveTextContent("~/code");
    expect(atlas).toHaveAttribute("title", ATLAS);
    expect(atlas.querySelector(".launcher-pm-ago")).toHaveTextContent("1h");
    expect(row(BEACON).querySelector(".launcher-pm-ago")).toHaveTextContent("2d");
    expect(row(COBALT).querySelector(".launcher-pm-ago")).toHaveTextContent("1w");
    expect(row("/fixture-home/notes/fjord").querySelector(".launcher-pm-ago")).toHaveTextContent("3mo");
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
    await typeSearch("/fixture-home/code/");
    const first = screen.getAllByRole("option")[0];
    expect(first).toHaveClass("launcher-pm-use");
    expect(first).toHaveTextContent("Use this folder/fixture-home/code/");
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
    expect(row(BEACON)).toHaveTextContent("Remove beacon from Hermes? Its files stay on disk; sessions using it lose the link.");
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
    // The search keeps the keyboard: the destructive button is never focused for you.
    expect(document.activeElement).toBe(search());
    fireEvent.keyDown(search(), { key: "Escape" });
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

  it("a held Backspace (clearing the search) never asks to remove", async () => {
    await openLauncher();
    await openMenu();
    await typeSearch("");
    fireEvent.keyDown(search(), { key: "Backspace", repeat: true });
    fireEvent.keyDown(search(), { key: "Delete", repeat: true });
    await settle();
    expect(document.querySelector(".launcher-pm-confirm")).toBeNull();
    // Enter then picks the highlighted project, as it would have anyway.
    fireEvent.keyDown(search(), { key: "Enter" });
    await settle();
    expect(h.deleted).toEqual([]);
  });

  it("after one Backspace, Enter does not remove; it closes the confirm", async () => {
    await openLauncher();
    await openMenu();
    fireEvent.keyDown(search(), { key: "Backspace" });
    await settle();
    expect(row(ATLAS)).toHaveClass("launcher-pm-confirm");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter" });
    await settle();
    expect(h.deleted).toEqual([]);
    expect(row(ATLAS)).not.toHaveClass("launcher-pm-confirm");
    expect(document.activeElement).toBe(search());
  });

  it("after one Backspace, a click on Remove (or Enter on it once tabbed to) removes", async () => {
    await openLauncher();
    await openMenu();
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "Backspace" });
    await settle();
    const remove = within(row(BEACON)).getByRole("button", { name: "Remove" });
    // Focused on purpose (Tab), Enter presses it.
    remove.focus();
    fireEvent.keyDown(remove, { key: "Enter" });
    await settle();
    expect(h.deleted).toEqual(["p-beacon"]);
    fireEvent.keyDown(search(), { key: "Home" });
    fireEvent.keyDown(search(), { key: "Backspace" });
    await settle();
    expect(row(ATLAS)).toHaveClass("launcher-pm-confirm");
    fireEvent.click(within(row(ATLAS)).getByRole("button", { name: "Remove" }));
    await settle();
    expect(h.deleted).toEqual(["p-beacon", "p-atlas"]);
  });

  it("a missing folder offers removal when chosen", async () => {
    await openLauncher();
    await openMenu();
    fireEvent.click(row(GONE));
    await settle();
    expect(row(GONE)).toHaveTextContent("Remove gone-app from Hermes? Its files stay on disk; sessions using it lose the link.");
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

const DELTA = "/fixture-home/code/delta";
const EMBER = "/fixture-home/code/ember";
const FJORD = "/fixture-home/notes/fjord";
const ZEPHYR = "/fixture-home/code/zephyr/docs";
const sectionNames = (label: string) => {
  const group = [...document.querySelectorAll(".launcher-pm-group")].find((g) => g.querySelector(".launcher-pm-section")?.textContent === label);
  return group ? [...group.querySelectorAll("[data-project-path] .launcher-pm-name")].map((n) => n.textContent) : null;
};
const check = (path: string) => row(path).querySelector(".launcher-pm-check") as HTMLInputElement;
const detail = (path: string) => row(path).querySelector(".launcher-pm-ago")?.textContent;
const alsoLine = () => document.querySelector(".task-launcher-extras") as HTMLElement | null;
async function toggle(path: string) {
  fireEvent.click(check(path));
  await settle();
}

describe("extra folders in the project menu", () => {
  beforeEach(() => {
    h.probe.set(BEACON, repoProbe(BEACON, "dev", 3));
  });

  it("the checkbox adds a folder: In this task on top with its branch and changes, the search clears, the menu stays open", async () => {
    await openLauncher();
    await openMenu();
    // Every row but the main project has a checkbox; the hints say both keys.
    expect(row(ATLAS).querySelector(".launcher-pm-check")).toBeNull();
    expect(check(BEACON)).not.toBeChecked();
    expect(document.querySelector(".launcher-pm")).not.toHaveAttribute("data-extras");
    const hints = document.querySelector(".launcher-pm-hints");
    expect(hints).toHaveTextContent("↵ main");
    expect(hints).toHaveTextContent("⇧↵ add folder");
    expect(hints).toHaveTextContent("launch");
    expect(hints).toHaveTextContent("esc close");

    await typeSearch("bea");
    await toggle(BEACON);
    expect(menu()).not.toBeNull();
    expect(search().value).toBe("");
    expect(document.activeElement).toBe(search());
    expect(sectionNames("In this task")).toEqual(["atlas", "beacon"]);
    expect(sectionNames("Recent")).toEqual(["cobalt", "delta", "ember", "fjord"]);
    expect(check(BEACON)).toBeChecked();
    expect(row(BEACON)).toHaveAttribute("data-extra");
    expect(detail(BEACON)).toBe("⎇ dev ●3");
    // Once one is checked, every row shows its checkbox.
    expect(document.querySelector(".launcher-pm")).toHaveAttribute("data-extras");

    // Clicking it again takes it out.
    await toggle(BEACON);
    expect(sectionNames("In this task")).toEqual(["atlas"]);
    expect(check(BEACON)).not.toBeChecked();
  });

  it("⇧↵ adds the highlighted folder (a folder that is not git says so), and ↵ still picks", async () => {
    const { onLaunch } = await openLauncher();
    await openMenu();
    await typeSearch("del");
    expect(highlighted()).toBe(row(DELTA));
    fireEvent.keyDown(search(), { key: "Enter", shiftKey: true });
    await settle();
    expect(menu()).not.toBeNull();
    expect(search().value).toBe("");
    expect(sectionNames("In this task")).toEqual(["atlas", "delta"]);
    expect(detail(DELTA)).toBe("not git");
    expect(chip()).toHaveTextContent("atlas +1");
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("↵ on an extra folder makes it the main project, and it is no longer an extra", async () => {
    await openLauncher();
    await openMenu();
    await toggle(BEACON);
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(highlighted()).toBe(row(BEACON));
    fireEvent.keyDown(search(), { key: "Enter" });
    await settle();
    expect(menu()).toBeNull();
    expect(chip()).toHaveTextContent("beacon");
    expect(chip()).not.toHaveTextContent("+");
    await openMenu();
    expect(sectionNames("In this task")).toEqual(["beacon"]);
    expect(row(BEACON)).toHaveAttribute("data-current");
    expect(check(ATLAS)).not.toBeChecked();
  });

  it("⌘⌫ takes the highlighted extra folder out; it never removes the project from the list", async () => {
    await openLauncher();
    await openMenu();
    await toggle(BEACON);
    await toggle(COBALT);
    expect(sectionNames("In this task")).toEqual(["atlas", "beacon", "cobalt"]);
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(highlighted()).toBe(row(BEACON));
    fireEvent.keyDown(search(), { key: "Backspace", ...modKey });
    await settle();
    expect(sectionNames("In this task")).toEqual(["atlas", "cobalt"]);
    expect(document.querySelector(".launcher-pm-confirm")).toBeNull();
    expect(h.deleted).toEqual([]);
    // On a row that is not an extra it does nothing.
    fireEvent.keyDown(search(), { key: "Home" });
    fireEvent.keyDown(search(), { key: "Backspace", ...modKey });
    await settle();
    expect(document.querySelector(".launcher-pm-confirm")).toBeNull();
    expect(chip()).toHaveTextContent("atlas +1");
  });

  it("says why a folder cannot be one: same repository (a worktree of it), inside or around the main project, missing", async () => {
    const WORKTREE = "/fixture-home/wt/atlas-fix";
    h.probe.set(WORKTREE, repoProbe(ATLAS, "fix"));
    h.projects.push(
      project("p-wt", "atlas-fix", WORKTREE, 0, null),
      project("p-inside", "atlas-site", "/fixture-home/code/atlas/site", 0, null),
      project("p-around", "code", "/fixture-home/code", 0, null),
    );
    await openLauncher();
    await openMenu();
    const blocked = (path: string, why: string) => {
      expect(check(path)).toBeDisabled();
      expect(row(path)).toHaveAttribute("title", why);
      expect(detail(path)).toBe(why);
    };
    blocked("/fixture-home/code/atlas/site", "inside atlas");
    blocked("/fixture-home/code", "contains atlas");
    blocked(GONE, "Folder not found");
    // The worktree is read when it is checked: the same repository as atlas, so it is not added.
    expect(check(WORKTREE)).not.toBeDisabled();
    await toggle(WORKTREE);
    expect(sectionNames("In this task")).toEqual(["atlas"]);
    blocked(WORKTREE, "same repository as atlas");
    // ⇧↵ on a disabled row does nothing.
    await typeSearch("atlas-site");
    fireEvent.keyDown(search(), { key: "Enter", shiftKey: true });
    await settle();
    expect(search().value).toBe("atlas-site");
    expect(chip()).toHaveTextContent("atlas");
    expect(chip()).not.toHaveTextContent("+");
  });

  it("a second folder of the same repository as an extra one is refused too", async () => {
    const OTHER = "/fixture-home/wt/beacon-fix";
    h.probe.set(OTHER, repoProbe(BEACON, "fix"));
    h.projects.push(project("p-bwt", "beacon-fix", OTHER, 0, null));
    await openLauncher();
    await openMenu();
    await toggle(BEACON);
    await toggle(OTHER);
    expect(sectionNames("In this task")).toEqual(["atlas", "beacon"]);
    expect(check(OTHER)).toBeDisabled();
    expect(detail(OTHER)).toBe("same repository as beacon");
  });

  it("takes at most 5 extra folders", async () => {
    await openLauncher();
    await openMenu();
    for (const path of [BEACON, COBALT, DELTA, EMBER, FJORD]) await toggle(path);
    expect(sectionNames("In this task")).toEqual(["atlas", "beacon", "cobalt", "delta", "ember", "fjord"]);
    expect(check(ZEPHYR)).toBeDisabled();
    expect(detail(ZEPHYR)).toBe("Up to 5 extra folders");
    expect(chip()).toHaveTextContent("atlas +5");
    // A checked one can still be unchecked, and then there is room again.
    await toggle(FJORD);
    expect(check(ZEPHYR)).not.toBeDisabled();
  });

  it("an agent that works in one folder has no checkboxes, says so, and its launch sends no extras", async () => {
    h.doctor = [doctorRow("claude", "Claude Code"), doctorRow("codex", "Codex CLI")];
    const { onLaunch } = await openLauncher();
    await openMenu();
    await toggle(BEACON);
    fireEvent.keyDown(search(), { key: "Escape" });
    await settle();
    expect(chip()).toHaveTextContent("atlas +1");
    fireEvent.click(document.querySelector('[data-chip="agent"]') as HTMLElement);
    await settle();
    fireEvent.click(document.querySelector('[data-agent-id="codex"]') as HTMLElement);
    await settle();
    expect(chip()).toHaveTextContent("atlas");
    expect(chip()).not.toHaveTextContent("+");
    expect(alsoLine()).toBeNull();
    await openMenu();
    expect(document.querySelector(".launcher-pm-check")).toBeNull();
    expect(sectionNames("In this task")).toEqual(["atlas"]);
    expect(document.querySelector(".launcher-pm-hints")).toHaveTextContent("This agent works in one folder");
    expect(document.querySelector(".launcher-pm-hints")).not.toHaveTextContent("add folder");
    fireEvent.keyDown(search(), { key: "Escape" });
    await settle();
    fireEvent.change(task(), { target: { value: "Fix the flaky test" } });
    await settle();
    fireEvent.keyDown(task(), { key: "Enter", ...modKey });
    await settle();
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch.mock.calls[0][0].extraRoots).toBeUndefined();
  });
});

describe("extra folders in the launcher", () => {
  beforeEach(() => {
    h.probe.set(BEACON, repoProbe(BEACON, "dev", 3));
  });

  it("the chip says +N with every path in its title; the Also line removes one; the launch sends projectIds in order, a branch for the main project only", async () => {
    const { onLaunch } = await openLauncher();
    await openMenu();
    await toggle(BEACON);
    await toggle(DELTA);
    fireEvent.keyDown(search(), { key: "Escape" });
    await settle();
    expect(chip()).toHaveTextContent("atlas +2");
    expect(chip()).toHaveAttribute("title", [ATLAS, BEACON, DELTA].join("\n"));
    const also = alsoLine() as HTMLElement;
    expect(also).toHaveTextContent("Also:");
    expect(also.querySelector(`[data-extra-path="${BEACON}"]`)).toHaveTextContent("beacon⎇ dev ●3");
    expect(also.querySelector(`[data-extra-path="${DELTA}"]`)).toHaveTextContent("deltanot git");
    expect(also).toHaveTextContent("— edited in place, not on the task branch");
    // The branch chip is about the main project only.
    expect(document.querySelector('[data-chip="where"]')).not.toHaveTextContent("beacon");
    expect(also.querySelector(".task-launcher-extras-shared")).toBeNull();

    fireEvent.click(within(also).getByRole("button", { name: "Remove delta from this task" }));
    await settle();
    expect(chip()).toHaveTextContent("atlas +1");
    expect(alsoLine()).not.toHaveTextContent("delta");

    fireEvent.change(task(), { target: { value: "Fix the login bug" } });
    await settle();
    fireEvent.keyDown(task(), { key: "Enter", ...modKey });
    await settle();
    expect(onLaunch).toHaveBeenCalledTimes(1);
    const req = onLaunch.mock.calls[0][0];
    expect(req.repoRoot).toBe(ATLAS);
    expect(req.extraRoots).toEqual([BEACON]);

    // What the app does with it: every folder a project, the main one first; the branch and worktree are the main project's.
    const { launchTask } = await import("../launcher/launchTask");
    const created: CreateSessionOpts[] = [];
    const ids: Record<string, string> = { [ATLAS]: "p-atlas", [BEACON]: "p-beacon" };
    await launchTask(req, {
      projectFor: async (root) => ids[root],
      createSession: async (opts) => (created.push(opts), { id: `s${created.length}` } as SessionData),
      place: () => {},
      worktreePath: async () => null,
      writeFeatureFile: async () => "",
      copyText: async () => {},
      readRecords: async () => "",
      writeRecords: async () => {},
      now: () => 1,
    });
    expect(created).toHaveLength(1);
    expect(created[0].projectIds).toEqual(["p-atlas", "p-beacon"]);
    expect(Object.keys(created[0].branchSelections ?? {})).toEqual(["p-atlas"]);
    expect(created[0].extraDirs).toEqual([BEACON]);
  });

  it("with a second agent on the task, the Also line warns that both share the folders' checkouts", async () => {
    h.doctor = [doctorRow("claude", "Claude Code"), doctorRow("codex", "Codex CLI")];
    await openLauncher();
    await openMenu();
    await toggle(BEACON);
    fireEvent.keyDown(search(), { key: "Escape" });
    await settle();
    fireEvent.click(document.querySelector(".task-launcher-expand") as HTMLElement);
    await settle();
    fireEvent.click(document.querySelector(".task-launcher-also-toggle") as HTMLElement);
    await settle();
    expect(alsoLine()?.querySelector(".task-launcher-extras-shared")).toHaveTextContent("2 agents will share these folders' checkouts");
  });
});

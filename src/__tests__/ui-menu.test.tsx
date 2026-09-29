// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { Menu, type MenuEntry } from "../components/ui/Menu";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup() {
  const calls: string[] = [];
  const act = (id: string) => () => calls.push(id);
  const entries: MenuEntry[] = [
    { id: "rename", label: "Rename", shortcut: "F2", onSelect: act("rename") },
    { id: "duplicate", label: "Duplicate", onSelect: act("duplicate") },
    { id: "archive", label: "Archive", disabled: true, onSelect: act("archive") },
    { id: "sep", separator: true },
    { id: "delete", label: "Delete session", danger: true, shortcut: "⌘⌫", onSelect: act("delete") },
  ];
  render(
    <>
      <Menu
        label="Session actions"
        entries={entries}
        renderTrigger={(p) => (
          <button type="button" {...p}>
            More
          </button>
        )}
      />
      <button type="button">after</button>
    </>,
  );
  return { calls };
}

const trigger = () => screen.getByRole("button", { name: "More" });
const menu = () => screen.getByRole("menu", { hidden: true });
const active = () => {
  const id = menu().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
};
const key = (k: string) => fireEvent.keyDown(menu(), { key: k });

describe("Menu — ARIA", () => {
  it("the trigger announces a menu and the items are menuitems with separators", () => {
    setup();
    expect(trigger()).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger().getAttribute("aria-controls")).toBe(menu().id);
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(menu()).toHaveAccessibleName("Session actions");
    expect(screen.getAllByRole("menuitem")).toHaveLength(4);
    expect(screen.getAllByRole("separator")).toHaveLength(1);
    expect(screen.getByRole("menuitem", { name: /Archive/ })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: /Delete session/ })).toHaveClass("h-menu-item--danger");
    expect(screen.getByRole("menuitem", { name: /Rename/ }).querySelector("kbd")).toHaveTextContent("F2");
  });

  it("focus moves into the open menu", () => {
    setup();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(menu()).toHaveFocus();
    expect(active()).toHaveTextContent("Rename");
  });
});

describe("Menu — keys", () => {
  it.each([["Enter"], [" "], ["ArrowDown"]])("%j on the trigger opens on the first item", (k) => {
    setup();
    fireEvent.keyDown(trigger(), { key: k });
    expect(active()).toHaveTextContent("Rename");
  });

  it("ArrowUp on the trigger opens on the last item", () => {
    setup();
    fireEvent.keyDown(trigger(), { key: "ArrowUp" });
    expect(active()).toHaveTextContent("Delete session");
  });

  it("arrows skip disabled items and separators and do not wrap", () => {
    setup();
    fireEvent.keyDown(trigger(), { key: "Enter" });
    key("ArrowDown");
    expect(active()).toHaveTextContent("Duplicate");
    key("ArrowDown");
    expect(active()).toHaveTextContent("Delete session");
    key("ArrowDown");
    expect(active()).toHaveTextContent("Delete session");
    key("Home");
    expect(active()).toHaveTextContent("Rename");
    key("ArrowUp");
    expect(active()).toHaveTextContent("Rename");
    key("End");
    expect(active()).toHaveTextContent("Delete session");
    key("PageUp");
    expect(active()).toHaveTextContent("Rename");
    key("PageDown");
    expect(active()).toHaveTextContent("Delete session");
  });

  it("type-ahead jumps to the item", () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    setup();
    fireEvent.keyDown(trigger(), { key: "Enter" });
    key("d");
    expect(active()).toHaveTextContent("Duplicate");
  });

  it("Enter runs the item, closes and returns focus to the trigger", () => {
    const { calls } = setup();
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "Enter" });
    key("ArrowDown");
    key("Enter");
    expect(calls).toEqual(["duplicate"]);
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).toHaveFocus();
  });

  it("Space runs the item", () => {
    const { calls } = setup();
    fireEvent.keyDown(trigger(), { key: "Enter" });
    key("End");
    key(" ");
    expect(calls).toEqual(["delete"]);
  });

  it("Escape closes without running anything and focuses the trigger", () => {
    const { calls } = setup();
    fireEvent.keyDown(trigger(), { key: "Enter" });
    key("Escape");
    expect(calls).toEqual([]);
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).toHaveFocus();
  });

  it("Tab closes the menu", () => {
    setup();
    fireEvent.keyDown(trigger(), { key: "Enter" });
    key("Tab");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).toHaveFocus();
  });
});

describe("Menu — pointer", () => {
  it("a click runs an item; a disabled item does nothing", async () => {
    const { calls } = setup();
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("menuitem", { name: /Archive/ }));
    expect(calls).toEqual([]);
    await userEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));
    expect(calls).toEqual(["rename"]);
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("a press outside closes it", async () => {
    setup();
    await userEvent.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(screen.getByRole("button", { name: "after" }));
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });
});

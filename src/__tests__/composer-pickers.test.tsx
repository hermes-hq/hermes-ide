// @vitest-environment jsdom
/**
 * The agent composer's model, effort and permission pickers are the kit
 * Menu: arrows, Home/End and type-ahead move, Enter picks, Esc closes and
 * gives focus back to the chip, and the current value carries the check.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ModelPicker } from "../components/ModelPicker";
import { EffortPicker } from "../components/EffortPicker";
import { PermissionPicker } from "../components/PermissionPicker";
import { CLAUDE_MODEL_OPTIONS } from "../agent/modelOptions";
import type { MenuTriggerProps } from "../components/ui/Menu";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const chip = (name: string) => (p: MenuTriggerProps) => (
  <button type="button" {...p}>
    {name}
  </button>
);
const menu = () => screen.getByRole("menu", { hidden: true });
const active = () => {
  const id = menu().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
};
const key = (k: string) => fireEvent.keyDown(menu(), { key: k });

describe("ModelPicker", () => {
  function setup(current: string | null = "claude-sonnet-4-6") {
    const onSelect = vi.fn();
    render(<ModelPicker options={CLAUDE_MODEL_OPTIONS} currentModel={current} onSelect={onSelect} renderTrigger={chip("sonnet")} />);
    return { onSelect, trigger: screen.getByRole("button", { name: "sonnet" }) };
  }

  it("opens from the chip with ↓, marks the current model and names the menu", () => {
    const { trigger } = setup();
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(menu()).toHaveAccessibleName("Select model");
    const radios = screen.getAllByRole("menuitemradio");
    expect(radios.map((r) => r.querySelector(".h-option-label")?.textContent)).toEqual(CLAUDE_MODEL_OPTIONS.map((o) => o.label));
    expect(screen.getByRole("menuitemradio", { name: /Sonnet/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /Opus/ })).toHaveAttribute("aria-checked", "false");
    // The escape hatch is an action, not a value.
    expect(screen.getByRole("menuitem", { name: /Open Claude's picker/ })).toBeInTheDocument();
    expect(active()).toHaveTextContent("Default");
  });

  it("type-ahead jumps to a model and Enter picks it; focus returns to the chip", () => {
    const { onSelect, trigger } = setup();
    fireEvent.keyDown(trigger, { key: "Enter" });
    key("o");
    expect(active()).toHaveTextContent("Opus");
    key("Enter");
    expect(onSelect).toHaveBeenCalledWith("opus");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(trigger);
  });

  it("Home and End reach the first and last rows; ↑ from the chip opens on the last", () => {
    const { onSelect, trigger } = setup();
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    expect(active()).toHaveTextContent("Open Claude's picker");
    key("Home");
    expect(active()).toHaveTextContent("Default");
    key("End");
    expect(active()).toHaveTextContent("Open Claude's picker");
    key("Enter");
    // The sentinel for "Open Claude's picker…".
    expect(onSelect).toHaveBeenCalledWith("");
  });

  it("Esc closes without picking", () => {
    const { onSelect, trigger } = setup();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    key("ArrowDown");
    key("Escape");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it("without discovered models it says so, and the row cannot be picked", () => {
    const onSelect = vi.fn();
    render(<ModelPicker options={[]} currentModel={null} onSelect={onSelect} renderTrigger={chip("model")} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "model" }), { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: /Discovery unavailable/ })).toHaveAttribute("aria-disabled", "true");
    // The first enabled row is the escape hatch.
    expect(active()).toHaveTextContent("Open Claude's picker");
  });
});

describe("EffortPicker", () => {
  const LEVELS = ["low", "medium", "high", "xhigh", "max"];

  it("marks the pending level over the saved one, and ↓ ↓ Enter picks two rows down", () => {
    const onSelect = vi.fn();
    render(<EffortPicker levels={LEVELS} current="low" pending="high" onSelect={onSelect} renderTrigger={chip("Effort")} />);
    const trigger = screen.getByRole("button", { name: "Effort" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(menu()).toHaveAccessibleName("Select thinking effort");
    expect(screen.getByRole("menuitemradio", { name: "high" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "low" })).toHaveAttribute("aria-checked", "false");
    key("ArrowDown");
    key("ArrowDown");
    key("Enter");
    expect(onSelect).toHaveBeenCalledWith("high");
  });

  it("typing the same letter again cycles through the levels that start with it", () => {
    const onSelect = vi.fn();
    render(<EffortPicker levels={["max", "medium", "low"]} current={null} pending={null} onSelect={onSelect} renderTrigger={chip("Effort")} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Effort" }), { key: "ArrowDown" });
    expect(active()).toHaveTextContent("max");
    key("m");
    expect(active()).toHaveTextContent("medium");
    key("m");
    expect(active()).toHaveTextContent("max");
  });
});

describe("PermissionPicker", () => {
  it("draws Bypass as a destructive row, checks the current mode, and picks with type-ahead", () => {
    const onSelect = vi.fn();
    render(<PermissionPicker current="plan" onSelect={onSelect} renderTrigger={chip("Plan")} />);
    const trigger = screen.getByRole("button", { name: "Plan" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(menu()).toHaveAccessibleName("Select permission mode");
    expect(screen.getByRole("menuitemradio", { name: /^Plan/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /^Bypass/ })).toHaveClass("h-menu-item--danger");
    key("a");
    expect(active()).toHaveTextContent("Accept Edits");
    key("Enter");
    expect(onSelect).toHaveBeenCalledWith("acceptEdits");
  });

  it("with no mode reported, Default is the current one", () => {
    render(<PermissionPicker current={null} onSelect={vi.fn()} renderTrigger={chip("Default")} />);
    fireEvent.click(screen.getByRole("button", { name: "Default" }));
    expect(screen.getByRole("menuitemradio", { name: /^Default/ })).toHaveAttribute("aria-checked", "true");
  });
});

describe("picker footers", () => {
  it("each menu ends with a note on what picking does, which describes the menu and is skipped by the keys", () => {
    const cases: Array<[string, () => void, string]> = [
      ["model", () => render(<ModelPicker options={CLAUDE_MODEL_OPTIONS} currentModel={null} onSelect={vi.fn()} renderTrigger={chip("model")} />), "From your next message: Claude restarts with the new --model, same conversation"],
      ["effort", () => render(<EffortPicker levels={["low", "high"]} current={null} pending={null} onSelect={vi.fn()} renderTrigger={chip("effort")} />), "From your next message: Claude restarts with the new --effort, same conversation"],
      ["perms", () => render(<PermissionPicker current={null} onSelect={vi.fn()} renderTrigger={chip("perms")} />), "Applies now; on your next message Claude restarts with the new --permission-mode"],
    ];
    for (const [name, mount, text] of cases) {
      mount();
      const trigger = screen.getByRole("button", { name });
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      const foot = menu().querySelector(".h-menu-footer");
      expect(foot).toHaveTextContent(text);
      expect(foot).toHaveAttribute("role", "none");
      expect(menu()).toHaveAccessibleDescription(text);
      // End lands on the last item, never on the note.
      key("End");
      expect(active()).not.toBe(foot);
      expect(active()?.getAttribute("role")).toMatch(/^menuitem/);
      cleanup();
    }
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { NativeSelect, Select, type SelectOption } from "../components/ui/Select";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const AGENTS: SelectOption[] = [
  { value: "claude-work", label: "Claude Code · Work", detail: "2.1.284" },
  { value: "claude-personal", label: "Claude Code · Personal", detail: "Pro" },
  { value: "codex", label: "Codex", detail: "0.145.0" },
  { value: "antigravity", label: "Antigravity", detail: "not installed", disabled: true },
  { value: "goose", label: "Goose" },
];

function Harness({ initial = "codex", options = AGENTS, onChange }: { initial?: string | null; options?: SelectOption[]; onChange?: (v: string) => void }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <>
      <Select
        aria-label="Agent"
        options={options}
        value={value}
        placeholder="Pick an agent"
        onChange={(v) => {
          setValue(v);
          onChange?.(v);
        }}
      />
      <button type="button">after</button>
    </>
  );
}

const trigger = () => screen.getByRole("combobox", { name: "Agent" });
const listbox = () => screen.getByRole("listbox", { hidden: true });
const activeOption = () => {
  const id = trigger().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
};
const key = (k: string, init: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(trigger(), { key: k, ...init });

describe("Select — ARIA", () => {
  it("is a combobox that controls a listbox and shows the value", () => {
    render(<Harness />);
    const t = trigger();
    expect(t).toHaveAttribute("aria-haspopup", "listbox");
    expect(t).toHaveAttribute("aria-expanded", "false");
    expect(t.getAttribute("aria-controls")).toBe(listbox().id);
    expect(t).toHaveTextContent("Codex");
    expect(t).not.toHaveAttribute("aria-activedescendant");
    expect(listbox()).not.toBeVisible();
  });

  it("shows the placeholder when nothing is selected", () => {
    render(<Harness initial={null} />);
    expect(trigger()).toHaveTextContent("Pick an agent");
  });

  it("marks the selected option, disabled options and details", () => {
    render(<Harness />);
    key("Enter");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(5);
    expect(options[2]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    expect(options[3]).toHaveAttribute("aria-disabled", "true");
    expect(options[0]).toHaveTextContent("2.1.284");
  });
});

describe("Select — opening", () => {
  it.each([["Enter"], [" "], ["ArrowDown"], ["ArrowUp"]])("%j opens on the selected option", (k) => {
    render(<Harness />);
    key(k);
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(listbox()).toBeVisible();
    expect(activeOption()).toHaveTextContent("Codex");
  });

  it("Alt+ArrowDown opens it", () => {
    render(<Harness />);
    key("ArrowDown", { altKey: true });
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
  });

  it("Home and End open it on the first and last enabled option", () => {
    render(<Harness />);
    key("End");
    expect(activeOption()).toHaveTextContent("Goose");
    key("Escape");
    key("Home");
    expect(activeOption()).toHaveTextContent("Claude Code · Work");
  });

  it("a click on the trigger toggles the list", async () => {
    render(<Harness />);
    await userEvent.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("a disabled select does not open and is not a tab stop", () => {
    render(<Select aria-label="Agent" options={AGENTS} value="codex" onChange={() => {}} disabled />);
    expect(trigger()).toHaveAttribute("tabindex", "-1");
    expect(trigger()).toHaveAttribute("aria-disabled", "true");
    key("Enter");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });
});

describe("Select — moving while open", () => {
  it("arrows move without wrapping and skip disabled options", () => {
    render(<Harness />);
    key("Enter"); // on Codex (index 2)
    key("ArrowDown");
    expect(activeOption()).toHaveTextContent("Goose"); // Antigravity is disabled
    key("ArrowDown");
    expect(activeOption()).toHaveTextContent("Goose"); // no wrap
    key("ArrowUp");
    key("ArrowUp");
    key("ArrowUp");
    key("ArrowUp");
    expect(activeOption()).toHaveTextContent("Claude Code · Work"); // no wrap at the top
  });

  it("PageDown / PageUp jump ten options and stop at the ends", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ value: `v${i}`, label: `Option ${String(i).padStart(2, "0")}` }));
    render(<Harness options={many} initial="v0" />);
    key("Enter");
    key("PageDown");
    expect(activeOption()).toHaveTextContent("Option 10");
    key("PageDown");
    key("PageDown");
    expect(activeOption()).toHaveTextContent("Option 29");
    key("PageUp");
    expect(activeOption()).toHaveTextContent("Option 19");
  });

  it("Home / End move to the first and last enabled option", () => {
    render(<Harness />);
    key("Enter");
    key("End");
    expect(activeOption()).toHaveTextContent("Goose");
    key("Home");
    expect(activeOption()).toHaveTextContent("Claude Code · Work");
  });
});

describe("Select — committing and reverting", () => {
  it("Enter commits the active option and closes", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    key("Enter");
    key("ArrowUp");
    key("Enter");
    expect(onChange).toHaveBeenCalledWith("claude-personal");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).toHaveTextContent("Claude Code · Personal");
  });

  it("Space commits the active option", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    key(" ");
    key("ArrowDown");
    key(" ");
    expect(onChange).toHaveBeenCalledWith("goose");
  });

  it("Escape reverts: the value stays and focus stays on the trigger", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    trigger().focus();
    key("Enter");
    key("ArrowDown");
    key("Escape");
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger()).toHaveTextContent("Codex");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).toHaveFocus();
  });

  it("Escape does not reach an enclosing dialog's key handler", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <Harness />
      </div>,
    );
    key("Enter");
    key("Escape");
    const keys = outer.mock.calls.map(([e]) => (e as { key: string }).key);
    expect(keys).toEqual(["Enter"]);
  });

  it("Tab commits the active option and moves focus on", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    trigger().focus();
    await userEvent.keyboard("{Enter}{ArrowDown}");
    await userEvent.tab();
    expect(onChange).toHaveBeenCalledWith("goose");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "after" })).toHaveFocus();
  });

  it("clicking an option commits it; clicking a disabled one does nothing", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("option", { name: /Antigravity/ }));
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("option", { name: /Goose/ }));
    expect(onChange).toHaveBeenCalledWith("goose");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("a press outside closes without changing the value", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    key("Enter");
    key("ArrowDown");
    await userEvent.click(screen.getByRole("button", { name: "after" }));
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Select — type-ahead", () => {
  it("typing while open moves to the match; repeating the letter cycles", () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    render(<Harness />);
    key("Enter"); // on Codex
    key("c");
    expect(activeOption()).toHaveTextContent("Claude Code · Work"); // next "c" after Codex, wrapping
    now += 100;
    key("c");
    expect(activeOption()).toHaveTextContent("Claude Code · Personal");
    now += 100;
    key("c");
    expect(activeOption()).toHaveTextContent("Codex");
  });

  it("keys within 500 ms build one prefix; a pause starts over", () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    render(<Harness />);
    key("Enter"); // on Codex
    key("g");
    now += 50;
    key("o");
    expect(activeOption()).toHaveTextContent("Goose");
    now += 50;
    key("c"); // "goc": no match, stays
    expect(activeOption()).toHaveTextContent("Goose");
    now += 600;
    key("c"); // a fresh search after the pause
    expect(activeOption()).toHaveTextContent("Claude Code · Work");
    now += 50;
    for (const ch of "laude code · p") {
      key(ch);
      now += 50;
    }
    expect(activeOption()).toHaveTextContent("Claude Code · Personal");
  });

  it("type-ahead never lands on a disabled option", () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    render(<Harness />);
    key("Enter");
    key("a");
    expect(activeOption()).toHaveTextContent("Codex"); // "Antigravity" is disabled: no move
  });

  it("typing while closed changes the value without opening, like a native select", () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    key("g");
    expect(onChange).toHaveBeenCalledWith("goose");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("Space during a type-ahead search types a space instead of committing", () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    key("Enter");
    key("c");
    now += 50;
    key("l");
    now += 50;
    key(" ");
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      now += 1000;
    });
    key(" ");
    expect(onChange).toHaveBeenCalledWith("claude-work");
  });
});

describe("NativeSelect", () => {
  it("is a real select with the trigger look and forwards changes", async () => {
    const onChange = vi.fn();
    render(
      <NativeSelect aria-label="Shell" value="zsh" onChange={(e) => onChange(e.target.value)}>
        <option value="zsh">zsh</option>
        <option value="bash">bash</option>
      </NativeSelect>,
    );
    const select = screen.getByRole("combobox", { name: "Shell" });
    expect(select.tagName).toBe("SELECT");
    expect(select).toHaveClass("h-input", "h-native-select-field");
    await userEvent.selectOptions(select, "bash");
    expect(onChange).toHaveBeenCalledWith("bash");
  });

  it("marks an invalid value", () => {
    render(
      <NativeSelect aria-label="Shell" invalid defaultValue="zsh">
        <option value="zsh">zsh</option>
      </NativeSelect>,
    );
    expect(screen.getByRole("combobox", { name: "Shell" })).toHaveAttribute("aria-invalid", "true");
  });
});

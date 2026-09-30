// @vitest-environment jsdom
// What the launch surfaces (task launcher, welcome, New Session creator)
// needed from the control set: a chip that opens its choices, a risky chip,
// and hooks (a class, a tooltip, data-*) on the focusable element of an
// option, so screens and their tests find a control without styling it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { Chip } from "../components/ui/Chip";
import { Segmented } from "../components/ui/Segmented";
import { Select } from "../components/ui/Select";
import { Checkbox, RadioGroup } from "../components/ui/Choice";

afterEach(cleanup);

describe("Chip that opens its choices", () => {
  function H({ onToggle }: { onToggle?: (open: boolean) => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Chip
          expands
          selected={open}
          onToggle={(next) => {
            onToggle?.(next);
            setOpen(next);
          }}
          buttonAttrs={{ className: "hook", "data-chip": "model", title: "the model" }}
        >
          model: opus
        </Chip>
        {open && <div role="group" aria-label="models" />}
      </>
    );
  }

  it("says whether its panel is open with aria-expanded (not aria-pressed) and turns brass while it is", async () => {
    const onToggle = vi.fn();
    render(<H onToggle={onToggle} />);
    const b = screen.getByRole("button", { name: "model: opus" });
    expect(b).toHaveAttribute("aria-expanded", "false");
    expect(b).not.toHaveAttribute("aria-pressed");
    expect(b.querySelector(".h-chip-chevron svg")).not.toBeNull();
    b.focus();
    await userEvent.keyboard("{Enter}");
    expect(onToggle).toHaveBeenLastCalledWith(true);
    expect(b).toHaveAttribute("aria-expanded", "true");
    expect(b.closest(".h-chip")).toHaveClass("h-chip--selected");
    expect(screen.getByRole("group", { name: "models" })).toBeInTheDocument();
    await userEvent.keyboard(" ");
    expect(b).toHaveAttribute("aria-expanded", "false");
  });

  it("puts the hook class, tooltip and data-* on its button, next to its own class", () => {
    render(<H />);
    const b = document.querySelector('[data-chip="model"]') as HTMLButtonElement;
    expect(b.tagName).toBe("BUTTON");
    expect(b).toHaveClass("h-chip-button", "hook");
    expect(b).toHaveAttribute("title", "the model");
  });

  it("a risky value carries the danger tone, open or not", () => {
    const { rerender } = render(
      <Chip tone="danger" selected={false} onToggle={() => {}}>
        Skip all
      </Chip>,
    );
    const chip = () => screen.getByRole("button", { name: "Skip all" }).closest(".h-chip");
    expect(chip()).toHaveClass("h-chip--danger");
    expect(chip()).not.toHaveClass("h-chip--selected");
    rerender(
      <Chip tone="danger" selected onToggle={() => {}}>
        Skip all
      </Chip>,
    );
    expect(chip()).toHaveClass("h-chip--danger", "h-chip--selected");
  });

  it("a disabled chip ignores presses", () => {
    const onToggle = vi.fn();
    render(
      <Chip expands selected={false} disabled onToggle={onToggle}>
        effort: n/a
      </Chip>,
    );
    const b = screen.getByRole("button", { name: "effort: n/a" });
    expect(b).toBeDisabled();
    fireEvent.click(b);
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("hooks on options", () => {
  it("a segment carries its option's class and data-*, and its label may be markup", async () => {
    function H() {
      const [v, setV] = useState<"terminal" | "agent">("terminal");
      return (
        <Segmented
          label="View"
          value={v}
          onChange={setV}
          options={[
            { value: "terminal", label: "Terminal", attrs: { "data-mode": "terminal", className: "hook" } },
            { value: "agent", label: <span className="rich">Agent view</span>, attrs: { "data-mode": "agent" } },
          ]}
        />
      );
    }
    render(<H />);
    const terminal = document.querySelector('[data-mode="terminal"]') as HTMLButtonElement;
    expect(terminal).toHaveAttribute("role", "radio");
    expect(terminal).toHaveClass("h-segment", "hook");
    expect(terminal).toHaveAttribute("aria-checked", "true");
    terminal.focus();
    await userEvent.keyboard("{ArrowRight}");
    const agent = document.querySelector('[data-mode="agent"]') as HTMLButtonElement;
    expect(agent).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(agent);
    expect(agent.querySelector(".rich")).not.toBeNull();
  });

  it("a radio carries its option's class and data-*; the row keeps the label", async () => {
    const onChange = vi.fn();
    render(
      <RadioGroup
        label="Recent"
        value="/repo/a"
        onChange={onChange}
        options={[
          { value: "/repo/a", label: "a", attrs: { className: "hook", "data-path": "/repo/a" } },
          { value: "/repo/b", label: "b", attrs: { "data-path": "/repo/b" } },
        ]}
      />,
    );
    const b = document.querySelector('[data-path="/repo/b"]') as HTMLInputElement;
    expect(b.tagName).toBe("INPUT");
    expect(document.querySelector('[data-path="/repo/a"]')).toHaveClass("h-radio", "hook");
    fireEvent.click(screen.getByText("b"));
    expect(onChange).toHaveBeenCalledWith("/repo/b");
  });

  it("a checkbox takes a hook class on the box itself", () => {
    const onChange = vi.fn();
    render(<Checkbox className="row" inputClassName="box" checked={false} onChange={onChange} label="Track as a feature" />);
    const box = screen.getByRole("checkbox", { name: "Track as a feature" });
    expect(box).toHaveClass("h-checkbox", "box");
    expect(box.closest("label")).toHaveClass("h-choice", "row");
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("a Select's trigger and options carry data-value, and the trigger follows a pick", () => {
    function H() {
      const [v, setV] = useState("");
      return (
        <Select
          aria-label="Base branch"
          value={v}
          onChange={setV}
          options={[
            { value: "", label: "current branch (main)" },
            { value: "develop", label: "develop" },
          ]}
        />
      );
    }
    render(<H />);
    const trigger = screen.getByRole("combobox", { name: "Base branch" });
    expect(trigger).toHaveAttribute("data-value", "");
    fireEvent.click(trigger);
    const list = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    const develop = list.querySelector('[data-value="develop"]') as HTMLElement;
    expect(develop).toHaveAttribute("role", "option");
    fireEvent.click(develop);
    expect(trigger).toHaveAttribute("data-value", "develop");
    expect(trigger).toHaveTextContent("develop");
  });
});

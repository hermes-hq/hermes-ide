// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { Button, CloseButton, IconButton } from "../components/ui/Button";
import { Input, Textarea } from "../components/ui/Input";
import { Chip } from "../components/ui/Chip";
import { Segmented } from "../components/ui/Segmented";
import { TabPanel, Tabs } from "../components/ui/Tabs";
import { Checkbox, RadioGroup, Toggle } from "../components/ui/Choice";
import { Badge, Counter } from "../components/ui/Badge";

afterEach(cleanup);

describe("Button", () => {
  it("is a type=button with its variant and size, and runs onClick from Enter and Space", async () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" size="lg" onClick={onClick}>
        Launch
      </Button>,
    );
    const b = screen.getByRole("button", { name: "Launch" });
    expect(b).toHaveAttribute("type", "button");
    expect(b).toHaveClass("h-btn", "h-btn--primary", "h-btn--lg");
    b.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("defaults to a secondary md button", () => {
    render(<Button>Choose…</Button>);
    expect(screen.getByRole("button")).toHaveClass("h-btn--secondary", "h-btn--md");
  });

  it("disabled: not pressable", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Launch
      </Button>,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("loading: busy, still focusable, ignores presses, keeps its label", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Saving
      </Button>,
    );
    const b = screen.getByRole("button", { name: "Saving" });
    expect(b).toHaveAttribute("aria-busy", "true");
    expect(b).toHaveAttribute("aria-disabled", "true");
    expect(b).not.toBeDisabled();
    b.focus();
    expect(b).toHaveFocus();
    await userEvent.click(b);
    await userEvent.keyboard("{Enter}");
    expect(onClick).not.toHaveBeenCalled();
  });

  it.each(["primary", "secondary", "quiet", "danger", "danger-solid", "link"] as const)("renders the %s variant", (variant) => {
    render(<Button variant={variant}>x</Button>);
    expect(screen.getByRole("button")).toHaveClass(`h-btn--${variant}`);
  });
});

describe("IconButton and CloseButton", () => {
  it("an icon button is named by its label (also its tooltip)", () => {
    render(<IconButton label="Refresh" icon={<svg />} />);
    const b = screen.getByRole("button", { name: "Refresh" });
    expect(b).toHaveAttribute("title", "Refresh");
    expect(b).toHaveClass("h-icon-btn--md");
  });

  it("a toggling icon button reports aria-pressed", () => {
    render(<IconButton label="Pin" icon={<svg />} pressed />);
    expect(screen.getByRole("button", { name: "Pin" })).toHaveAttribute("aria-pressed", "true");
  });

  it("Close is a small icon button with one drawn ×, named by its label", async () => {
    const onClick = vi.fn();
    render(<CloseButton label="Close Settings" onClick={onClick} />);
    const b = screen.getByRole("button", { name: "Close Settings" });
    expect(b).toHaveClass("h-icon-btn--sm", "h-close-btn");
    expect(b.querySelectorAll("svg")).toHaveLength(1);
    expect(b.textContent).toBe("");
    b.focus();
    await userEvent.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("Input and Textarea", () => {
  it("an input takes typing and is sized md by default", async () => {
    const onChange = vi.fn();
    render(<Input aria-label="Search sessions" onChange={(e) => onChange(e.target.value)} />);
    const input = screen.getByRole("textbox", { name: "Search sessions" });
    expect(input).toHaveClass("h-input", "h-input--md");
    await userEvent.type(input, "abc");
    expect(onChange).toHaveBeenLastCalledWith("abc");
  });

  it("the code variant is marked", () => {
    render(<Input aria-label="Branch" code defaultValue="hermes/fix" />);
    expect(screen.getByRole("textbox", { name: "Branch" })).toHaveClass("h-input--code");
  });

  it("an error marks the field invalid and is linked with aria-describedby", () => {
    render(<Input aria-label="Branch" aria-describedby="hint" error="That branch already exists" />);
    const input = screen.getByRole("textbox", { name: "Branch" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    const ids = input.getAttribute("aria-describedby")!.split(" ");
    expect(ids[0]).toBe("hint");
    expect(document.getElementById(ids[1])).toHaveTextContent("That branch already exists");
    expect(input).toHaveAccessibleDescription(/That branch already exists/);
  });

  it("invalid without a message still sets aria-invalid, and no describedby", () => {
    render(<Input aria-label="Name" invalid />);
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).not.toHaveAttribute("aria-describedby");
  });

  it("a textarea supports the same error link", () => {
    render(<Textarea aria-label="Notes" error="Too long" />);
    const ta = screen.getByRole("textbox", { name: "Notes" });
    expect(ta).toHaveClass("h-textarea");
    expect(ta).toHaveAccessibleDescription("Too long");
  });
});

describe("Chip", () => {
  it("a selectable chip is a toggle button with aria-pressed", async () => {
    function H() {
      const [on, setOn] = useState(false);
      return (
        <Chip selected={on} onToggle={setOn}>
          Accept edits
        </Chip>
      );
    }
    render(<H />);
    const b = screen.getByRole("button", { name: "Accept edits" });
    expect(b).toHaveAttribute("aria-pressed", "false");
    b.focus();
    await userEvent.keyboard(" ");
    expect(b).toHaveAttribute("aria-pressed", "true");
    expect(b.closest(".h-chip")).toHaveClass("h-chip--selected");
  });

  it("a removable chip has a named × that removes it by keyboard", async () => {
    const onRemove = vi.fn();
    render(
      <Chip onRemove={onRemove} removeLabel="Remove opus">
        opus
      </Chip>,
    );
    const x = screen.getByRole("button", { name: "Remove opus" });
    x.focus();
    await userEvent.keyboard("{Enter}");
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("a plain chip is not interactive", () => {
    render(<Chip>effort: high</Chip>);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("effort: high").closest(".h-chip")).toHaveClass("h-chip--md");
  });
});

describe("Segmented", () => {
  function H({ onChange }: { onChange?: (v: string) => void }) {
    const [v, setV] = useState("turn");
    return (
      <Segmented
        label="Group by"
        value={v}
        onChange={(n) => {
          setV(n);
          onChange?.(n);
        }}
        options={[
          { value: "file", label: "By file" },
          { value: "turn", label: "By turn" },
          { value: "risky", label: "Risky", disabled: true },
          { value: "all", label: "All" },
        ]}
      />
    );
  }

  it("is a radiogroup with one tab stop on the selected segment", () => {
    render(<H />);
    expect(screen.getByRole("radiogroup", { name: "Group by" })).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("tabindex"))).toEqual(["-1", "0", "-1", "-1"]);
    expect(screen.getByRole("radio", { name: "By turn" })).toHaveAttribute("aria-checked", "true");
  });

  it("arrows move and select, skipping disabled, wrapping; Home/End jump", () => {
    const onChange = vi.fn();
    render(<H onChange={onChange} />);
    const turn = screen.getByRole("radio", { name: "By turn" });
    turn.focus();
    fireEvent.keyDown(turn, { key: "ArrowRight" });
    const all = screen.getByRole("radio", { name: "All" });
    expect(all).toHaveFocus();
    expect(all).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(all, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "By file" })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(screen.getByRole("radio", { name: "By file" }), { key: "End" });
    expect(screen.getByRole("radio", { name: "All" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("radio", { name: "All" }), { key: "Home" });
    expect(screen.getByRole("radio", { name: "By file" })).toHaveAttribute("aria-checked", "true");
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["all", "file", "all", "file"]);
  });

  it("Tab leaves the group after one stop", async () => {
    render(
      <>
        <H />
        <button type="button">next</button>
      </>,
    );
    screen.getByRole("radio", { name: "By turn" }).focus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "next" })).toHaveFocus();
  });
});

describe("Tabs", () => {
  function H({ orientation = "horizontal" as "horizontal" | "vertical" }) {
    const [v, setV] = useState("review");
    const tabs = [
      { value: "review", label: "Review" },
      { value: "repo", label: "Repository" },
      { value: "wt", label: "Worktrees" },
    ];
    return (
      <>
        <Tabs idPrefix="t" label="Review Desk" tabs={tabs} value={v} onChange={setV} orientation={orientation} />
        {tabs.map((t) =>
          t.value === v ? (
            <TabPanel key={t.value} idPrefix="t" value={t.value}>
              {t.label} panel
            </TabPanel>
          ) : null,
        )}
      </>
    );
  }

  it("tablist, tabs and panel are wired together", () => {
    render(<H />);
    const list = screen.getByRole("tablist", { name: "Review Desk" });
    expect(list).toHaveAttribute("aria-orientation", "horizontal");
    const tab = screen.getByRole("tab", { name: "Review" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAccessibleName("Review");
    expect(tab.getAttribute("aria-controls")).toBe(panel.id);
  });

  it("horizontal: ←/→ select at once (automatic activation), wrapping; Home/End", () => {
    render(<H />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Review" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Repository" })).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Repository panel");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Repository" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Worktrees" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Worktrees" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Review" })).toHaveAttribute("aria-selected", "true");
    // Up/Down do nothing in a horizontal list.
    fireEvent.keyDown(screen.getByRole("tab", { name: "Review" }), { key: "ArrowDown" });
    expect(screen.getByRole("tab", { name: "Review" })).toHaveAttribute("aria-selected", "true");
  });

  it("vertical: ↑/↓ move instead", () => {
    render(<H orientation="vertical" />);
    expect(screen.getByRole("tablist")).toHaveAttribute("aria-orientation", "vertical");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Review" }), { key: "ArrowDown" });
    expect(screen.getByRole("tab", { name: "Repository" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Repository" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Repository" })).toHaveAttribute("aria-selected", "true");
  });

  it("only the selected tab is a tab stop", () => {
    render(<H />);
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
  });
});

describe("Checkbox, Toggle, Radio", () => {
  it("a checkbox toggles with Space and is named by its label", async () => {
    function H() {
      const [on, setOn] = useState(false);
      return <Checkbox label="Stage file" checked={on} onChange={setOn} />;
    }
    render(<H />);
    const box = screen.getByRole("checkbox", { name: "Stage file" });
    box.focus();
    await userEvent.keyboard(" ");
    expect(box).toBeChecked();
  });

  it("an indeterminate checkbox reports mixed", () => {
    render(<Checkbox label="All files" checked={false} indeterminate onChange={() => {}} />);
    const box = screen.getByRole("checkbox", { name: "All files" }) as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    expect(box).toHaveAttribute("aria-checked", "mixed");
    expect(box).toBePartiallyChecked();
  });

  it("a toggle is a switch; Space and Enter flip it", async () => {
    function H() {
      const [on, setOn] = useState(false);
      return <Toggle label="Status line above agent sessions" checked={on} onChange={setOn} />;
    }
    render(<H />);
    const sw = screen.getByRole("switch", { name: "Status line above agent sessions" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    sw.focus();
    await userEvent.keyboard(" ");
    expect(sw).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{Enter}");
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("clicking a toggle's label flips it", async () => {
    const onChange = vi.fn();
    render(<Toggle label="Wrap lines" checked={false} onChange={onChange} />);
    await userEvent.click(screen.getByText("Wrap lines"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("a disabled toggle does not flip", async () => {
    const onChange = vi.fn();
    render(<Toggle label="Wrap lines" checked={false} onChange={onChange} disabled />);
    await userEvent.click(screen.getByRole("switch"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a radio group has one tab stop; arrows move and select, skipping disabled", () => {
    function H() {
      const [v, setV] = useState<"new" | "existing" | "none">("new");
      return (
        <RadioGroup
          label="Where to work"
          value={v}
          onChange={setV}
          options={[
            { value: "new", label: "New worktree" },
            { value: "existing", label: "Existing branch", disabled: true },
            { value: "none", label: "This folder", description: "Changes land in your checkout" },
          ]}
        />
      );
    }
    render(<H />);
    expect(screen.getByRole("radiogroup", { name: "Where to work" })).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    fireEvent.keyDown(radios[0], { key: "ArrowDown" });
    expect(screen.getByRole("radio", { name: /This folder/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /This folder/ })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("radio", { name: /This folder/ }), { key: "ArrowDown" });
    expect(screen.getByRole("radio", { name: "New worktree" })).toBeChecked();
    fireEvent.keyDown(screen.getByRole("radio", { name: "New worktree" }), { key: "ArrowUp" });
    expect(screen.getByRole("radio", { name: /This folder/ })).toBeChecked();
  });
});

describe("Badge and Counter", () => {
  it("a badge carries its tone", () => {
    render(<Badge tone="success">Exact</Badge>);
    expect(screen.getByText("Exact")).toHaveClass("h-badge", "h-badge--success");
  });

  it("a counter caps at max and can carry a spoken label", () => {
    render(<Counter value={120} tone="attention" label="120 agents need you" />);
    expect(screen.getByText("99+")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("120 agents need you")).toHaveClass("h-visually-hidden");
    expect(screen.getByText("99+").parentElement).toHaveClass("h-counter--attention");
  });
});

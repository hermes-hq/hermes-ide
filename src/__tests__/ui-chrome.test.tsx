// @vitest-environment jsdom
/**
 * UI-B — the always-visible chrome on the control set: the ListRow (current
 * row and highlight), the action Chip of the pane header, Badge and Counter
 * attributes, the activity bar's neutral counter, and the command palette's
 * rows (32 px ListRows, the session in view marked current, the arrows move
 * the highlight named by aria-activedescendant, Enter runs it).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("../hooks/useTextContextMenu", () => ({ useTextContextMenu: () => ({ onContextMenu: () => {} }) }));
vi.mock("../api/sessions", () => ({
  sshListPortForwards: vi.fn(() => Promise.resolve([])),
  sshAddPortForward: vi.fn(() => Promise.resolve()),
  sshRemovePortForward: vi.fn(() => Promise.resolve()),
}));
vi.mock("../api/settings", () => ({
  getSetting: vi.fn(() => Promise.resolve(null)),
  setSetting: vi.fn(() => Promise.resolve()),
}));

import { Badge, Chip, Counter, ListRow } from "../components/ui";
import { ActivityBar } from "../components/ActivityBar";
import { CommandPalette } from "../components/CommandPalette";
import { PortForwardsPanel } from "../components/PortForwardsPanel";
import { I18nProvider } from "../i18n/I18nProvider";
import { registerLanguagePack, setLanguage } from "../i18n/registry";
import type { SessionData } from "../types/session";

afterEach(async () => {
  cleanup();
  await setLanguage("en");
});

describe("ListRow", () => {
  it("marks the current row and the highlighted row, and passes role, id, aria and handlers through", () => {
    const onClick = vi.fn();
    render(
      <div role="listbox">
        <ListRow id="r1" role="option" aria-selected={false} size="sm" current onClick={onClick}>
          one
        </ListRow>
        <ListRow id="r2" role="option" aria-selected size="lg" highlighted>
          two
        </ListRow>
        <ListRow id="r3" role="option" aria-selected={false}>
          three
        </ListRow>
      </div>,
    );
    const [one, two, three] = screen.getAllByRole("option");
    expect(one).toHaveAttribute("data-current");
    expect(one).not.toHaveAttribute("data-highlighted");
    expect(one).toHaveClass("h-row", "h-row--sm");
    expect(two).toHaveAttribute("data-highlighted");
    expect(two).not.toHaveAttribute("data-current");
    expect(two).toHaveClass("h-row", "h-row--lg");
    expect(three).not.toHaveAttribute("data-current");
    expect(three).not.toHaveAttribute("data-highlighted");
    expect(three.className).toBe("h-row");
    fireEvent.click(one);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("Chip", () => {
  it("an action chip is one button that says whether its popover is open", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Chip size="sm" className="agent-rules-chip" expanded={false} haspopup="dialog" title="Instruction files" data-state="passed" onClick={onClick}>
        CLAUDE.md
      </Chip>,
    );
    const chip = screen.getByRole("button", { name: "CLAUDE.md" });
    expect(chip).toHaveClass("h-chip", "h-chip--sm", "h-chip--action", "agent-rules-chip");
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(chip).toHaveAttribute("aria-haspopup", "dialog");
    expect(chip).toHaveAttribute("title", "Instruction files");
    expect(chip).toHaveAttribute("data-state", "passed");
    expect(chip.querySelectorAll("button")).toHaveLength(0);
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Chip size="sm" expanded haspopup="dialog" onClick={onClick}>
        CLAUDE.md
      </Chip>,
    );
    expect(screen.getByRole("button", { name: "CLAUDE.md" })).toHaveAttribute("aria-expanded", "true");
  });

  it("a static chip carries its title and data attributes; a removable one has a named ×", () => {
    const onRemove = vi.fn();
    render(
      <>
        <Chip size="sm" data-testid="model" title="Model opus">
          opus
        </Chip>
        <Chip size="sm" onRemove={onRemove} removeLabel="Remove project">
          web
        </Chip>
      </>,
    );
    expect(screen.getByTestId("model")).toHaveAttribute("title", "Model opus");
    expect(screen.getByTestId("model")).toHaveClass("h-chip", "h-chip--sm");
    fireEvent.click(screen.getByRole("button", { name: "Remove project" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

describe("Badge and Counter", () => {
  it("a badge takes role and title (a status word with its explanation)", () => {
    render(
      <Badge tone="warning" role="status" title="--dangerously-skip-permissions">
        Looser than default
      </Badge>,
    );
    const badge = screen.getByRole("status");
    expect(badge).toHaveClass("h-badge", "h-badge--warning");
    expect(badge).toHaveAttribute("title", "--dangerously-skip-permissions");
  });

  it("a counter is neutral unless it needs you, and says which", () => {
    const { container } = render(
      <>
        <Counter value={3} />
        <Counter value={120} tone="attention" />
      </>,
    );
    const [plain, hot] = [...container.querySelectorAll(".h-counter")];
    expect(plain).toHaveAttribute("data-tone", "neutral");
    expect(plain).toHaveClass("h-counter--neutral");
    expect(hot).toHaveAttribute("data-tone", "attention");
    expect(hot).toHaveTextContent("99+");
  });
});

describe("the activity bar", () => {
  const icon = <svg />;
  it("counts with a neutral Counter by default, brass only when the tab says it needs you, nothing at zero", () => {
    const { container } = render(
      <ActivityBar
        side="left"
        pinnedTabs={[
          { id: "sessions", label: "Sessions", icon, badge: 4 },
          { id: "waiting", label: "Waiting", icon, badge: 2, badgeTone: "attention" },
          { id: "empty", label: "Empty", icon, badge: 0 },
        ]}
        tabs={[]}
        activeTabId={null}
        onTabClick={() => {}}
      />,
    );
    const counters = [...container.querySelectorAll(".activity-bar-badge")];
    expect(counters).toHaveLength(2);
    expect(counters[0]).toHaveClass("h-counter", "h-counter--neutral");
    expect(counters[0]).toHaveTextContent("4");
    expect(counters[1]).toHaveClass("h-counter--attention");
  });
});

describe("the command palette", () => {
  const session = (id: string, label: string) => ({ id, label, detected_agent: null }) as unknown as SessionData;
  const sessions = [session("s1", "alpha-task"), session("s2", "bravo-task")];

  function renderPalette(activeSessionId: string | null, onSelectSession = vi.fn()) {
    render(
      <I18nProvider>
        <CommandPalette
          onClose={() => {}}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={onSelectSession}
          onNewSession={() => {}}
          onToggleContext={() => {}}
          onToggleSessions={() => {}}
          onOpenSettings={() => {}}
          onOpenWorkspace={() => {}}
        />
      </I18nProvider>,
    );
    return { input: screen.getByRole("combobox"), list: screen.getByRole("listbox"), onSelectSession };
  }

  it("rows are one-line ListRows; the session in view is the current row", () => {
    const { list } = renderPalette("s2");
    const options = within(list).getAllByRole("option");
    for (const o of options) expect(o).toHaveClass("h-row", "h-row--sm", "command-palette-item");
    const current = options.filter((o) => o.hasAttribute("data-current"));
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("bravo-task");
    expect(current[0]).toHaveAttribute("aria-current", "true");
  });

  it("the list of results has a name of its own, not the field's placeholder", () => {
    const { input, list } = renderPalette(null);
    expect(list).toHaveAccessibleName("Commands and sessions");
    expect(list.getAttribute("aria-label")).not.toBe(input.getAttribute("placeholder"));
  });

  it("no session in view: no current row", () => {
    const { list } = renderPalette(null);
    expect(within(list).getAllByRole("option").some((o) => o.hasAttribute("data-current"))).toBe(false);
  });

  it("↓ ↑ move the highlight, named by aria-activedescendant on the field; Enter runs it", () => {
    const { input, list, onSelectSession } = renderPalette("s1");
    const options = () => within(list).getAllByRole("option");
    expect(input).toHaveAttribute("aria-controls", list.id);
    expect(input).toHaveAttribute("aria-activedescendant", options()[0].id);
    expect(options()[0]).toHaveAttribute("data-highlighted");
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", options()[2].id);
    expect(options().filter((o) => o.hasAttribute("data-highlighted"))).toEqual([options()[2]]);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAttribute("aria-activedescendant", options()[1].id);
    // Filter down to one session and run it with Enter.
    fireEvent.change(input, { target: { value: "bravo" } });
    expect(options()).toHaveLength(1);
    expect(input).toHaveAttribute("aria-activedescendant", options()[0].id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelectSession).toHaveBeenCalledWith("s2");
  });
});

describe("the port forwards panel", () => {
  it("its Close is named in the person's language and closes the panel", async () => {
    const onClose = vi.fn();
    render(
      <I18nProvider>
        <PortForwardsPanel sessionId="s1" onClose={onClose} />
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    const pack = registerLanguagePack({ locale: "xxchrome", label: "Chrome Test", messages: { "common.close": "XX-close" } });
    try {
      await act(async () => {
        await setLanguage("xxchrome");
      });
      expect(screen.getByRole("button", { name: "XX-close" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    } finally {
      pack.dispose();
    }
  });
});

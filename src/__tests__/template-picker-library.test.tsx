// @vitest-environment jsdom
/**
 * The prompt Builder's template picker: Hermes's prompts live in the
 * Library, which is the first tab and the one it opens on. There is no
 * "Built-in" tab; "My Templates" keeps the person's saved templates and
 * groups. A pinned 2.0 built-in the catalog has no entry for still shows
 * under Pinned.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("../components/library/LibraryPicker", () => ({
  LibraryPicker: ({ onPick }: { onPick: (p: { text: string }) => void }) => (
    <button data-testid="library-picker" onClick={() => onPick({ text: "library text" })}>
      library
    </button>
  ),
}));

import { I18nProvider } from "../i18n/I18nProvider";
import { TemplatePicker } from "../components/TemplatePicker";
import type { PromptTemplate } from "../lib/templates";

const mine: PromptTemplate = {
  id: "user-1",
  name: "Ship checklist",
  category: "planning",
  fields: { task: "Release" },
  recommendedRoles: [],
  recommendedStyles: [],
  builtIn: false,
  group: "Release",
};
const oldPinned: PromptTemplate = { id: "debug-root-cause", name: "Root Cause Analysis", category: "debugging", fields: {}, recommendedRoles: [], recommendedStyles: [], builtIn: true };

function picker(extra: Partial<Parameters<typeof TemplatePicker>[0]> = {}) {
  const props = {
    userTemplates: [mine],
    onSelect: vi.fn(),
    onDeleteUser: vi.fn(),
    open: true,
    onToggle: vi.fn(),
    pinnedIds: new Set<string>(),
    onTogglePin: vi.fn(),
    templateGroups: ["Release"],
    onCreateGroup: vi.fn(),
    onRenameGroup: vi.fn(),
    onDeleteGroup: vi.fn(),
    onMoveToGroup: vi.fn(),
    onSelectLibrary: vi.fn(),
    ...extra,
  };
  render(
    <I18nProvider>
      <TemplatePicker {...props} />
    </I18nProvider>,
  );
  return props;
}

afterEach(cleanup);

describe("template picker", () => {
  it("opens on the Library, the first tab, with no Built-in tab", () => {
    const props = picker();
    const tabs = screen.getAllByRole("button").filter((b) => b.className.includes("template-picker-tab"));
    expect(tabs.map((b) => b.textContent?.replace(/\d+$/, ""))).toEqual(["Library", "My Templates"]);
    expect(tabs[0]).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Built-in")).toBeNull();
    fireEvent.click(screen.getByTestId("library-picker"));
    expect(props.onSelectLibrary).toHaveBeenCalledWith("library text");
  });

  it("keeps the person's saved templates and groups under My Templates", () => {
    const props = picker();
    fireEvent.click(screen.getByText("My Templates"));
    expect(screen.queryByTestId("library-picker")).toBeNull();
    expect(screen.getByText("Release")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Ship checklist"));
    expect(props.onSelect).toHaveBeenCalledWith(mine);
  });

  it("shows a pinned 2.0 built-in the catalog has no entry for under Pinned", () => {
    picker({ fallbackTemplates: [oldPinned], pinnedIds: new Set(["debug-root-cause"]) });
    fireEvent.click(screen.getByText("My Templates"));
    expect(screen.getByText("Root Cause Analysis")).toBeInTheDocument();
  });
});

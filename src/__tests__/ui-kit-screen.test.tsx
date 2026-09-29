// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("../i18n/I18nProvider", async () => {
  const { translate } = await import("../i18n/registry");
  return { useI18n: () => ({ t: translate }) };
});

import { UiKitScreen } from "../components/ui/UiKitScreen";

afterEach(() => {
  cleanup();
  document.head.querySelectorAll("style[data-test]").forEach((s) => s.remove());
  delete document.documentElement.dataset.theme;
});

describe("the hidden controls preview", () => {
  it("renders every control family, named for assistive tech", () => {
    render(<UiKitScreen onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Controls" })).toBeInTheDocument();
    for (const name of ["Buttons", "Text fields", "Select", "Chips", "Checkbox, toggle, radio", "Badges and counters"]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
    // Every button variant in six states, plus the size row.
    for (const v of ["primary", "secondary", "quiet", "danger", "danger-solid", "link"]) {
      for (const s of ["default", "hover", "active", "focus", "disabled", "loading"]) {
        expect(document.querySelector(`[data-kit="btn-${v}-${s}"]`), `${v} ${s}`).toBeInTheDocument();
      }
    }
    expect(document.querySelectorAll('[role="combobox"][aria-haspopup="listbox"]').length).toBeGreaterThanOrEqual(4);
    expect(screen.getByRole("button", { name: "More actions" })).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.getAllByRole("switch").length).toBe(3);
    expect(screen.getAllByRole("tablist").length).toBe(2);
    expect(screen.getAllByRole("radiogroup").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole("checkbox", { name: "All files" })).toBePartiallyChecked();
    expect(screen.getByRole("textbox", { name: "Branch", description: /already exists/ })).toHaveAttribute("aria-invalid", "true");
  });

  it("switches the theme for a look and puts the user's theme back on close", () => {
    document.documentElement.dataset.theme = "atelier";
    const { unmount } = render(<UiKitScreen onClose={() => {}} />);
    fireEvent.change(document.querySelector('[data-kit="theme"]')!, { target: { value: "frosted-light" } });
    expect(document.documentElement.dataset.theme).toBe("frosted-light");
    unmount();
    expect(document.documentElement.dataset.theme).toBe("atelier");
  });

  it("shows hover, pressed and focus by copying the stylesheet's own rules, and removes them on close", () => {
    const sheet = document.createElement("style");
    sheet.dataset.test = "";
    sheet.textContent = ".h-demo:hover { color: red; } .h-demo:focus-visible { outline: 2px solid blue; } .h-demo { color: green; }";
    document.head.appendChild(sheet);
    const { unmount } = render(<UiKitScreen onClose={() => {}} />);
    const preview = document.head.querySelector("style[data-ui-kit-preview]");
    expect(preview?.textContent).toContain('.h-demo[data-preview~="hover"]');
    expect(preview?.textContent).toContain('.h-demo[data-preview~="focus"]');
    expect(preview?.textContent).not.toMatch(/^\.h-demo \{/m);
    unmount();
    expect(document.head.querySelector("style[data-ui-kit-preview]")).toBeNull();
  });

  it("the close button closes it", () => {
    const onClose = vi.fn();
    render(<UiKitScreen onClose={onClose} />);
    fireEvent.click(document.querySelector('[data-kit="close"]')!);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

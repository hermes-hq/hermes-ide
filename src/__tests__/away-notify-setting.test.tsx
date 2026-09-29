// @vitest-environment jsdom
/**
 * N16 — Settings > Away notifications: the address can carry a secret (a
 * Telegram bot token), so it is masked unless being edited; it is saved on
 * blur or Enter, and only when empty or an http(s) URL.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { AwayNotifySetting } from "../components/AwayNotifySetting";
import { I18nProvider } from "../i18n/I18nProvider";

const TOKEN_URL = "https://api.telegram.org/bot123456:SYNTHETIC-token/sendMessage?chat_id=1";

afterEach(cleanup);

function setup(value = "") {
  const onSave = vi.fn();
  render(
    <I18nProvider>
      <AwayNotifySetting value={value} onSave={onSave} />
    </I18nProvider>,
  );
  const input = document.getElementById("away-notify-url") as HTMLInputElement;
  return { onSave, input };
}

describe("N16 away address field", () => {
  it("masks a saved address and shows it only while editing", () => {
    const { input } = setup(TOKEN_URL);
    expect(input).toHaveAttribute("type", "password");
    expect(input.value).toBe(TOKEN_URL);
    fireEvent.focus(input);
    expect(input).toHaveAttribute("type", "url");
    fireEvent.blur(input);
    expect(input).toHaveAttribute("type", "password");
  });

  it("saves an http(s) address on Enter, refuses anything else", () => {
    const { input, onSave } = setup("");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ftp://example.test/x" } });
    fireEvent.blur(input);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: TOKEN_URL } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSave).toHaveBeenCalledWith("away_notify_url", TOKEN_URL);
  });

  it("a saved value that arrives late never replaces what the person is typing", () => {
    const onSave = vi.fn();
    const view = (value: string) => (
      <I18nProvider>
        <AwayNotifySetting value={value} onSave={onSave} />
      </I18nProvider>
    );
    const { rerender } = render(view(""));
    const input = document.getElementById("away-notify-url") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: TOKEN_URL } });
    // The settings finish loading while the field has the keyboard.
    rerender(view("https://late.example/old"));
    expect(input.value).toBe(TOKEN_URL);
    fireEvent.blur(input);
    expect(onSave).toHaveBeenCalledWith("away_notify_url", TOKEN_URL);
  });

  it("a typed, refused address is kept when the saved value arrives after the blur", () => {
    const onSave = vi.fn();
    const view = (value: string) => (
      <I18nProvider>
        <AwayNotifySetting value={value} onSave={onSave} />
      </I18nProvider>
    );
    const { rerender } = render(view(""));
    const input = document.getElementById("away-notify-url") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ftp://nope.example" } });
    fireEvent.blur(input);
    rerender(view("https://late.example/old"));
    expect(input.value).toBe("ftp://nope.example");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("follows a saved value that arrives late while the field is untouched", () => {
    const onSave = vi.fn();
    const view = (value: string) => (
      <I18nProvider>
        <AwayNotifySetting value={value} onSave={onSave} />
      </I18nProvider>
    );
    const { rerender } = render(view(""));
    rerender(view(TOKEN_URL));
    const input = document.getElementById("away-notify-url") as HTMLInputElement;
    expect(input.value).toBe(TOKEN_URL);
  });
});

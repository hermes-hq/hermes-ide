// @vitest-environment jsdom
/**
 * N16 (LEAD-08, LEAD-09, LEAD-10) — Settings > General, around the away
 * address: when to send ("Send after"), whether messages may name sessions,
 * how the last message went, and a test message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const h = vi.hoisted(() => ({
  send: vi.fn(async (_payload: unknown): Promise<unknown> => ({ outcome: "sent", status: 200, target: "webhook" })),
  setSetting: vi.fn(async (_k: string, _v: string) => {}),
  settings: {} as Record<string, string>,
}));

vi.mock("../api/attention", () => ({ AWAY_NOTIFY_URL_KEY: "away_notify_url", sendAwayNotification: h.send }));
vi.mock("../api/settings", () => ({ getSettings: vi.fn(async () => ({ ...h.settings })), setSetting: h.setSetting }));

import { AwayNotifySetting, AWAY_TEST_PAYLOAD } from "../components/AwayNotifySetting";
import { I18nProvider } from "../i18n/I18nProvider";
import { _resetAwayPrefsForTest, getAwayPrefs, loadAwayPrefs, parseAwayDelay, awayDelayMs } from "../attention/awayPrefs";
import { _resetAwayLastForTest, noteAwayResult } from "../attention/awayStatus";

const URL = "https://hooks.example.test/hermes";

function setup(value = URL) {
  const onSave = vi.fn();
  render(
    <I18nProvider>
      <AwayNotifySetting value={value} onSave={onSave} />
    </I18nProvider>,
  );
  return { onSave };
}

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
});

beforeEach(() => {
  _resetAwayPrefsForTest();
  _resetAwayLastForTest();
  h.settings = {};
  h.send.mockClear();
  h.setSetting.mockClear();
});
afterEach(cleanup);

describe("Send after", () => {
  it("reads 2 minutes unless set; only the three choices are taken", () => {
    expect(parseAwayDelay(undefined)).toBe("120");
    expect(parseAwayDelay("0")).toBe("0");
    expect(parseAwayDelay("600")).toBe("600");
    expect(parseAwayDelay("45")).toBe("120");
    expect(awayDelayMs("600")).toBe(600_000);
  });

  it("says when Hermes sends, offers Immediately / After 2 min / After 10 min, and saves the choice at once", async () => {
    const { onSave } = setup();
    await flush();
    expect(screen.getByText(/When an agent is blocked on you and Hermes is not in front of you, Hermes sends one message to this address/)).toBeInTheDocument();
    const select = document.getElementById("away-notify-delay")!;
    expect(select).toHaveAttribute("data-value", "120");
    expect(select).toHaveTextContent("After 2 min");
    fireEvent.click(select);
    const list = document.getElementById(select.getAttribute("aria-controls")!)!;
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Immediately", "After 2 min", "After 10 min"]);
    fireEvent.click(options[0]);
    expect(onSave).toHaveBeenCalledWith("away_notify_delay", "0");
    expect(getAwayPrefs().delay).toBe("0");
  });

  it("follows what is stored", async () => {
    h.settings = { away_notify_delay: "600", away_notify_names: "on" };
    await loadAwayPrefs();
    setup();
    await flush();
    expect(document.getElementById("away-notify-delay")).toHaveAttribute("data-value", "600");
    expect(screen.getByRole("switch", { name: "Include session names in away messages" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("Include session names in away messages", () => {
  it("is off by default, says where names can come from, and saves on/off", async () => {
    const { onSave } = setup();
    await flush();
    const toggle = screen.getByRole("switch", { name: "Include session names in away messages" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/can come from your first message/)).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(onSave).toHaveBeenCalledWith("away_notify_names", "on");
    expect(getAwayPrefs().includeNames).toBe(true);
  });
});

describe("the last message and Send test message", () => {
  it("says how the last message went, under the address", () => {
    setup();
    expect(document.querySelector(".away-notify-last")).toBeNull();
    act(() => {
      noteAwayResult({ outcome: "failed", error: "the address answered 500 Internal Server Error", target: "webhook" }, new Date(2026, 0, 1, 12, 4).getTime());
    });
    expect(document.querySelector(".away-notify-last")?.textContent).toMatch(/^Last message: failed 12:04.*: the address answered 500 Internal Server Error$/);
    act(() => {
      noteAwayResult({ outcome: "sent", status: 200, target: "webhook" }, new Date(2026, 0, 1, 12, 5).getTime());
    });
    expect(document.querySelector(".away-notify-last")?.textContent).toMatch(/^Last message: sent 12:05.* ✓$/);
    // Nothing configured, nothing sent: nothing to say.
    act(() => {
      noteAwayResult({ outcome: "unset" });
    });
    expect(document.querySelector(".away-notify-last")?.textContent).toMatch(/sent 12:05/);
  });

  it("sends the test message (no agent, no task) and shows the result", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await flush();
    expect(h.send).toHaveBeenCalledWith(AWAY_TEST_PAYLOAD);
    expect(AWAY_TEST_PAYLOAD).toEqual({ agent: "Hermes", task: "test", state: "test", where: "" });
    expect(document.querySelector(".away-notify-last")?.textContent).toMatch(/^Last message: sent .* ✓$/);
    h.send.mockImplementationOnce(async () => ({ outcome: "failed", error: "the address answered 404 Not Found", target: "webhook" }));
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await flush();
    expect(document.querySelector(".away-notify-last")?.textContent).toMatch(/failed .*: the address answered 404 Not Found$/);
  });

  it("saves a typed address before testing it, and cannot test an empty one", async () => {
    const { onSave } = setup("");
    const button = screen.getByRole("button", { name: "Send test message" });
    expect(button).toBeDisabled();
    const input = document.getElementById("away-notify-url") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: URL } });
    let stored: () => void = () => {};
    onSave.mockImplementationOnce(() => new Promise<void>((done) => (stored = done)));
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await flush();
    // Saved once, through Settings; the test waits until it is stored.
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("away_notify_url", URL);
    expect(h.setSetting).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    stored();
    await flush();
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

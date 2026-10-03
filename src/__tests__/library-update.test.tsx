// @vitest-environment jsdom
/**
 * The Library's update panel and the words it uses for each signature
 * verdict: a valid signature applies, a bad one or an unknown key is
 * refused, and a catalog with no signature yet is "waiting for a signed
 * release" (a quiet note, not an error) while the bundled catalog stays.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../api/settings", () => ({
  getSetting: vi.fn(async () => ""),
  setSetting: vi.fn(async () => {}),
  getSettings: vi.fn(async () => ({})),
}));

import { I18nProvider } from "../i18n/I18nProvider";
import { useLibraryMessages } from "../library/messages";
import { libraryEn } from "../library/messages/en";
import { awaitingSignedRelease, LibraryUpdatePanel, outcomeText } from "../components/library/LibraryUpdate";
import type { LibraryStatus, UpdateOutcome } from "../library/types";

const t = (key: string, values?: Record<string, string | number>) => {
  let s = (libraryEn as Record<string, string>)[key] ?? key;
  for (const [k, v] of Object.entries(values ?? {})) s = s.replace(`{${k}}`, String(v));
  return s;
};

const refused = (code: string, reason = "x"): UpdateOutcome => ({ outcome: "refused", code, reason });

function status(over: Partial<LibraryStatus> = {}): LibraryStatus {
  return {
    ready: true,
    catalog: { catalog: "2026.1003.1", seq: 4, manifestSha256: "x", source: "bundled", rows: 1900, appliedAt: 1 },
    bundled: ["2026.1003.1", 4],
    hasBundledArchive: true,
    offlineBodies: 1900,
    updates: "auto",
    lastCheck: Math.floor(Date.now() / 1000) - 60,
    lastSuccess: Math.floor(Date.now() / 1000) - 60,
    lastError: null,
    trustedKeys: 1,
    importMs: 100,
    lastOutcome: null,
    checking: false,
    error: null,
    ...over,
  } as LibraryStatus;
}

function Gate({ children }: { children: ReactNode }) {
  return useLibraryMessages() ? <>{children}</> : null;
}

const show = (s: LibraryStatus) =>
  render(
    <I18nProvider>
      <Gate>
        <LibraryUpdatePanel status={s} onChanged={() => {}} />
      </Gate>
    </I18nProvider>,
  );

afterEach(() => {
  cleanup();
  h.invoke.mockReset();
});

describe("outcomeText for signature verdicts", () => {
  it("valid: an applied update says the signature was verified", () => {
    const text = outcomeText(t, { outcome: "applied", bytes: 10, summary: { catalog: "2026.1004.0", seq: 1, rows: 3, added: ["a"], changed: [], removed: [], revoked: [] } });
    expect(text).toMatch(/Updated to 2026\.1004\.0: 1 new.*Signature and every file verified/);
  });

  it("invalid: a bad signature or an unknown key is refused, nothing changed", () => {
    expect(outcomeText(t, refused("signature"))).toBe(libraryEn["library.update.refusedSignature"]);
    expect(outcomeText(t, refused("key"))).toBe(libraryEn["library.update.refusedKey"]);
    expect(outcomeText(t, refused("key"))).toMatch(/does not trust\. Nothing was changed/);
    expect(outcomeText(t, refused("hash", "object abc does not match its hash"))).toMatch(/Update refused: object abc/);
  });

  it("missing: no signature yet is waiting for a signed release, not a refusal", () => {
    expect(awaitingSignedRelease(refused("unsigned"))).toBe(true);
    expect(awaitingSignedRelease(refused("signature"))).toBe(false);
    expect(awaitingSignedRelease(null)).toBe(false);
    const text = outcomeText(t, refused("unsigned"));
    expect(text).toMatch(/No signed library release yet/);
    expect(text).toMatch(/catalog that came with Hermes/);
    expect(text).not.toMatch(/refused/i);
  });
});

describe("LibraryUpdatePanel", () => {
  it("while the catalog is unsigned: a quiet note, no error, updates stay on", async () => {
    show(status({ lastOutcome: refused("unsigned") }));
    expect(await screen.findByTestId("library-update-waiting")).toHaveTextContent(/No signed library release yet/);
    expect(document.querySelector(".lib-blocked")).toBeNull();
    expect(screen.getByText(/every 12 hours, in the background/)).toBeInTheDocument();
  });

  it("a refused signature shows as an error", async () => {
    show(status({ lastOutcome: refused("signature"), lastError: "the catalog signature does not match its contents" }));
    await waitFor(() => expect(document.querySelector(".lib-blocked")).toHaveTextContent(/signature did not verify/));
    expect(screen.queryByTestId("library-update-waiting")).toBeNull();
  });

  it("Check now reports the verdict once", async () => {
    h.invoke.mockImplementation(async (cmd: string) => (cmd === "library_check_update" ? refused("unsigned") : null));
    show(status({ lastOutcome: refused("unsigned") }));
    fireEvent.click(await screen.findByRole("button", { name: /Check now/ }));
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("library_check_update", { apply: null }));
    await waitFor(() => expect(screen.getAllByText(/No signed library release yet/)).toHaveLength(1));
  });
});

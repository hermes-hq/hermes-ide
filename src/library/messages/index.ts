// ─── The Library's strings ───────────────────────────────────────────
//
// They load with the Library (and the launcher's library row), not at
// startup: English plus one module per built-in language, added to the
// registered packs with extendMessages. Whenever the language changes (or
// its own messages finish loading and replace what was added), the
// current language's Library strings are added again. The parity test
// (src/__tests__/i18n-library-parity.test.ts) holds every language to the
// English keys and placeholders.

import { useEffect, useState } from "react";
import { extendMessages, getCurrentLanguage, getI18nSnapshot, subscribeI18n, type TranslationMessages } from "../../i18n/registry";
import { libraryEn } from "./en";

export const LIBRARY_LOCALES = ["de", "es", "fr", "hi", "ja", "pt-BR", "ru", "zh-CN"] as const;

const loaders: Record<string, () => Promise<TranslationMessages>> = {
  de: () => import("./de").then((m) => m.libraryDe),
  es: () => import("./es").then((m) => m.libraryEs),
  fr: () => import("./fr").then((m) => m.libraryFr),
  hi: () => import("./hi").then((m) => m.libraryHi),
  ja: () => import("./ja").then((m) => m.libraryJa),
  "pt-BR": () => import("./pt-BR").then((m) => m.libraryPtBR),
  ru: () => import("./ru").then((m) => m.libraryRu),
  "zh-CN": () => import("./zh-CN").then((m) => m.libraryZhCN),
};

/** Every language's strings (tests and tooling). */
export async function loadAllLibraryMessages(): Promise<Record<string, TranslationMessages>> {
  const out: Record<string, TranslationMessages> = {};
  for (const locale of LIBRARY_LOCALES) out[locale] = await loaders[locale]();
  return out;
}

const PROBE = Object.keys(libraryEn)[0];
const inFlight = new Map<string, Promise<void>>();

/** Adds the current language's Library strings when its pack lacks them. */
function sync(): Promise<void> {
  const locale = getCurrentLanguage();
  const load = loaders[locale];
  const pack = getI18nSnapshot().languages.find((p) => p.locale === locale);
  // English is always there; a pack whose own messages have not arrived yet is synced once they do.
  if (!load || !pack || Object.keys(pack.messages).length === 0 || pack.messages[PROBE] !== undefined) return Promise.resolve();
  let p = inFlight.get(locale);
  if (!p) {
    p = load()
      .then((messages) => {
        extendMessages(locale, messages);
      })
      .catch((err: unknown) => console.warn(`[library] strings for ${locale} did not load:`, err))
      .finally(() => inFlight.delete(locale));
    inFlight.set(locale, p);
  }
  return p;
}

let ready: Promise<void> | null = null;
let isReady = false;

export function ensureLibraryMessages(): Promise<void> {
  if (!ready) {
    extendMessages("en", libraryEn);
    subscribeI18n(() => void sync());
    ready = sync().then(() => {
      isReady = true;
    });
  }
  return ready;
}

/** True once the Library's strings are there (English at least). */
export function useLibraryMessages(): boolean {
  const [ok, setOk] = useState(isReady);
  useEffect(() => {
    if (isReady) return;
    let live = true;
    ensureLibraryMessages()
      .catch(() => {})
      .finally(() => {
        if (live) setOk(true);
      });
    return () => {
      live = false;
    };
  }, []);
  return ok;
}

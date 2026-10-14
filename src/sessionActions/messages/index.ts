// ─── The agent catalog's command strings ──────────────────────────────
//
// A built-in command without an action ("/memory", "/skills") has its own
// label and description in the agent catalog (English, src/catalog/
// agents.json); the ones with an action use the action's strings, which are
// in every language pack (sessionActions.action.*). The English goes into
// the registry from the catalog itself (no copy to keep in step), and each
// built-in language's translations load on demand, the first time a session
// shows its action bar, the way the Library's strings do. The parity test
// (src/__tests__/session-actions-i18n.test.ts) holds every language to the
// catalog's keys.

import { extendMessages, getCurrentLanguage, getI18nSnapshot, subscribeI18n, type TranslationMessages } from "../../i18n/registry";
import { catalogCommandMessages } from "../catalog";

export const COMMAND_MESSAGE_LOCALES = ["de", "es", "fr", "hi", "ja", "pt-BR", "ru", "zh-CN"] as const;

const loaders: Record<string, () => Promise<TranslationMessages>> = {
  de: () => import("./de").then((m) => m.commandsDe),
  es: () => import("./es").then((m) => m.commandsEs),
  fr: () => import("./fr").then((m) => m.commandsFr),
  hi: () => import("./hi").then((m) => m.commandsHi),
  ja: () => import("./ja").then((m) => m.commandsJa),
  "pt-BR": () => import("./pt-BR").then((m) => m.commandsPtBR),
  ru: () => import("./ru").then((m) => m.commandsRu),
  "zh-CN": () => import("./zh-CN").then((m) => m.commandsZhCN),
};

/** Every language's command strings (tests and tooling). */
export async function loadAllCommandMessages(): Promise<Record<string, TranslationMessages>> {
  const out: Record<string, TranslationMessages> = {};
  for (const locale of COMMAND_MESSAGE_LOCALES) out[locale] = await loaders[locale]();
  return out;
}

let english: TranslationMessages | null = null;
const inFlight = new Map<string, Promise<void>>();

/** Adds the current language's command strings when its pack lacks them. */
function sync(): void {
  if (!english) {
    english = catalogCommandMessages();
    extendMessages("en", english);
  }
  const locale = getCurrentLanguage();
  const load = loaders[locale];
  const pack = getI18nSnapshot().languages.find((p) => p.locale === locale);
  const probe = Object.keys(english)[0];
  if (!load || !pack || Object.keys(pack.messages).length === 0 || probe === undefined || pack.messages[probe] !== undefined) return;
  if (inFlight.has(locale)) return;
  inFlight.set(
    locale,
    load()
      .then((messages) => {
        extendMessages(locale, messages);
      })
      .catch((err: unknown) => console.warn(`[session-actions] command strings for ${locale} did not load:`, err))
      .finally(() => inFlight.delete(locale)),
  );
}

let started = false;

/** Keeps the command strings of the current language in the registry from now on. */
export function startCommandMessages(): void {
  if (started) return;
  started = true;
  sync();
  subscribeI18n(sync);
}

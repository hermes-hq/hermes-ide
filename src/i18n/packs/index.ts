import type { LanguagePack, LazyLanguagePack } from "../registry";

/**
 * The built-in interface languages. Only the names live in the startup
 * bundle; each language's translations are a separate chunk, fetched when
 * that language is chosen (or restored at startup).
 */
export const languagePacks: LazyLanguagePack[] = [
  { locale: "ru", label: "Russian", nativeLabel: "Русский", load: () => import("./ru").then((m) => m.ruPack) },
  { locale: "es", label: "Spanish", nativeLabel: "Español", load: () => import("./es").then((m) => m.esPack) },
  { locale: "hi", label: "Hindi", nativeLabel: "हिन्दी", load: () => import("./hi").then((m) => m.hiPack) },
  { locale: "fr", label: "French", nativeLabel: "Français", load: () => import("./fr").then((m) => m.frPack) },
  { locale: "de", label: "German", nativeLabel: "Deutsch", load: () => import("./de").then((m) => m.dePack) },
  {
    locale: "pt-BR",
    label: "Portuguese (Brazil)",
    nativeLabel: "Português (Brasil)",
    load: () => import("./pt-BR").then((m) => m.ptBRPack),
  },
  {
    locale: "zh-CN",
    label: "Chinese (Simplified)",
    nativeLabel: "简体中文",
    load: () => import("./zh-CN").then((m) => m.zhCNPack),
  },
  { locale: "ja", label: "Japanese", nativeLabel: "日本語", load: () => import("./ja").then((m) => m.jaPack) },
];

/** Every built-in pack with its messages (tests and tooling). */
export function loadAllLanguagePacks(): Promise<LanguagePack[]> {
  return Promise.all(languagePacks.map((entry) => entry.load()));
}

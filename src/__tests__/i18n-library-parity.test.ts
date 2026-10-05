/**
 * Parity gate for the Library's strings (src/library/messages): they load
 * with the Library, not at startup, and every built-in language must carry
 * exactly the English keys with the same {placeholders}, like the main
 * packs (i18n-packs-parity.test.ts).
 */
import { describe, expect, it } from "vitest";
import { languagePacks } from "../i18n/packs";
import { LIBRARY_LOCALES, loadAllLibraryMessages } from "../library/messages";
import { libraryEn } from "../library/messages/en";

const all = await loadAllLibraryMessages();
const EN_KEYS = Object.keys(libraryEn).sort();
const tokens = (v: string) => [...new Set([...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

describe("library strings parity", () => {
  it("covers every built-in language", () => {
    expect([...LIBRARY_LOCALES].sort()).toEqual(languagePacks.map((p) => p.locale).sort());
  });

  it("keeps every key under library.", () => {
    expect(EN_KEYS.filter((k) => !k.startsWith("library."))).toEqual([]);
  });

  for (const locale of LIBRARY_LOCALES) {
    it(`${locale}: exactly the English keys`, () => {
      const keys = Object.keys(all[locale]).sort();
      expect(keys.filter((k) => !EN_KEYS.includes(k)), "extra keys").toEqual([]);
      expect(EN_KEYS.filter((k) => !keys.includes(k)), "missing keys").toEqual([]);
    });

    it(`${locale}: the same placeholders on every key, and clean values`, () => {
      const bad: string[] = [];
      for (const k of EN_KEYS) {
        const v = all[locale][k] ?? "";
        if (tokens(libraryEn[k]).join() !== tokens(v).join()) bad.push(`${k}: {${tokens(libraryEn[k])}} vs {${tokens(v)}}`);
        if (/\\u[0-9a-fA-F]{4}/.test(v) || v.includes("\r")) bad.push(`${k}: escape or CR`);
        if (!v.trim()) bad.push(`${k}: empty`);
      }
      expect(bad).toEqual([]);
    });
  }
});

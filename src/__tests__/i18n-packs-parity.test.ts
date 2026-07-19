/**
 * PERMANENT parity gate for the built-in language packs.
 *
 * Every pack shipped in src/i18n/packs/ must be a complete, structurally
 * sound translation of the English base pack embedded in the registry:
 *
 *   (a) identical key sets — no missing keys, no extra keys;
 *   (b) identical {placeholder} token sets per key — a translator may
 *       reorder or inflect, but must never drop/rename an interpolation
 *       token (a missing token silently renders "{count}" to the user);
 *   (c) value hygiene — no stray literal \uXXXX escapes (someone pasted
 *       an escaped sequence instead of the real character) and no
 *       carriage returns (CRLF accidents break rendered copy).
 *
 * Failure messages name the exact locale + offending keys so a pack edit
 * that breaks parity is fixable without digging.
 */
import { describe, it, expect } from "vitest";
import { getI18nSnapshot, type LanguagePack } from "../i18n/registry";
import { languagePacks } from "../i18n/packs";

const english = getI18nSnapshot().languages.find((p) => p.locale === "en");
if (!english) {
  throw new Error("English base pack is not registered in the i18n registry");
}
const ENGLISH: LanguagePack = english;
const EN_KEYS = Object.keys(ENGLISH.messages).sort();

function placeholderTokens(value: string): string[] {
  const tokens = new Set<string>();
  for (const match of value.matchAll(/\{(\w+)\}/g)) {
    tokens.add(match[1]);
  }
  return Array.from(tokens).sort();
}

describe("language pack parity gate", () => {
  it("ships exactly the expected locale set", () => {
    expect(languagePacks.map((p) => p.locale).sort()).toEqual([
      "de",
      "es",
      "fr",
      "hi",
      "ja",
      "pt-BR",
      "ru",
      "zh-CN",
    ]);
  });

  it("has no duplicate locales", () => {
    const locales = languagePacks.map((p) => p.locale);
    expect(new Set(locales).size).toBe(locales.length);
  });

  describe("(a) key sets match the English base", () => {
    for (const pack of languagePacks) {
      it(`${pack.locale}: exactly the ${EN_KEYS.length} English keys`, () => {
        const packKeys = new Set(Object.keys(pack.messages));
        const enKeys = new Set(EN_KEYS);
        const missing = EN_KEYS.filter((k) => !packKeys.has(k));
        const extra = Object.keys(pack.messages).filter((k) => !enKeys.has(k));
        expect(
          missing,
          `locale "${pack.locale}" is missing ${missing.length} key(s):\n  ${missing.join("\n  ")}`,
        ).toEqual([]);
        expect(
          extra,
          `locale "${pack.locale}" has ${extra.length} key(s) English lacks:\n  ${extra.join("\n  ")}`,
        ).toEqual([]);
      });
    }
  });

  describe("(b) {placeholder} token sets match per key", () => {
    for (const pack of languagePacks) {
      it(`${pack.locale}: identical placeholder tokens on every key`, () => {
        const diffs: string[] = [];
        for (const key of EN_KEYS) {
          const enTokens = placeholderTokens(ENGLISH.messages[key]);
          const packValue = pack.messages[key] ?? "";
          const packTokens = placeholderTokens(packValue);
          if (enTokens.join("") !== packTokens.join("")) {
            diffs.push(
              `  ${key}: English {${enTokens.join("},{")}} vs ${pack.locale} {${packTokens.join("},{")}}`,
            );
          }
        }
        expect(
          diffs,
          `locale "${pack.locale}" has ${diffs.length} placeholder mismatch(es):\n${diffs.join("\n")}`,
        ).toEqual([]);
      });
    }
  });

  describe("(c) value hygiene — no stray \\uXXXX escapes, no carriage returns", () => {
    for (const pack of [ENGLISH, ...languagePacks]) {
      it(`${pack.locale}: clean values`, () => {
        const bad: string[] = [];
        for (const [key, value] of Object.entries(pack.messages)) {
          if (/\\u[0-9a-fA-F]{4}/.test(value)) {
            bad.push(`  ${key}: stray \\uXXXX escape in ${JSON.stringify(value)}`);
          }
          if (value.includes("\r")) {
            bad.push(`  ${key}: contains a carriage return in ${JSON.stringify(value)}`);
          }
        }
        expect(
          bad,
          `locale "${pack.locale}" has ${bad.length} hygiene violation(s):\n${bad.join("\n")}`,
        ).toEqual([]);
      });
    }
  });
});

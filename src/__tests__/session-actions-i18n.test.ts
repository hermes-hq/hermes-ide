/**
 * Parity gate for the agent catalog's command strings (src/sessionActions/
 * messages): every built-in language carries exactly the keys the catalog's
 * English gives (a label and description per command without an action, a
 * consequence per flagged one), with clean values. A catalog edit that adds
 * a command fails here until every language has it.
 */
import { describe, expect, it } from "vitest";
import { languagePacks } from "../i18n/packs";
import { catalogCommandMessages } from "../sessionActions/catalog";
import { COMMAND_MESSAGE_LOCALES, loadAllCommandMessages } from "../sessionActions/messages";

const all = await loadAllCommandMessages();
const english = catalogCommandMessages();
const EN_KEYS = Object.keys(english).sort();

describe("agent command strings parity", () => {
  it("covers every built-in language", () => {
    expect([...COMMAND_MESSAGE_LOCALES].sort()).toEqual(languagePacks.map((p) => p.locale).sort());
  });

  for (const locale of COMMAND_MESSAGE_LOCALES) {
    it(`${locale}: exactly the catalog's keys, with clean values`, () => {
      const keys = Object.keys(all[locale]).sort();
      expect(keys.filter((k) => !EN_KEYS.includes(k)), "extra keys").toEqual([]);
      expect(EN_KEYS.filter((k) => !keys.includes(k)), "missing keys").toEqual([]);
      const bad = EN_KEYS.filter((k) => {
        const v = all[locale][k] ?? "";
        return !v.trim() || /\\u[0-9a-fA-F]{4}/.test(v) || v.includes("\r") || (k.endsWith(".description") && v.trim().endsWith("."));
      });
      expect(bad).toEqual([]);
    });
  }
});

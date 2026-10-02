// ─── Plural forms for count-bearing strings ───────────────────────────
//
// A count-bearing message has one key per CLDR plural category of the
// language: `<key>.one`, `<key>.other` (and `.few`, `.many` where the
// language has them). The category comes from Intl.PluralRules for the
// current language; a pack without that form falls back to `.other`, then
// to the bare key. "1 file", "2 files" — never "1 files".

import { getCurrentLanguage, translate } from "./registry";

const rulesByLocale = new Map<string, Intl.PluralRules>();

function rulesFor(locale: string): Intl.PluralRules {
  let rules = rulesByLocale.get(locale);
  if (!rules) {
    try {
      rules = new Intl.PluralRules(locale);
    } catch {
      rules = new Intl.PluralRules("en");
    }
    rulesByLocale.set(locale, rules);
  }
  return rules;
}

/** `key` in the plural form for `count`; `{count}` is filled in. */
export function translatePlural(key: string, count: number, values: Record<string, string | number> = {}, locale = getCurrentLanguage()): string {
  const all = { ...values, count };
  for (const form of [`${key}.${rulesFor(locale).select(count)}`, `${key}.other`, key]) {
    const text = translate(form, all);
    if (text !== form) return text;
  }
  return key;
}

// ESLint rule: new UI surfaces must not hardcode user-facing English text.
//
// Hermes ships ten language packs (src/i18n/packs/), each held to full
// parity with the English base pack by src/__tests__/i18n-packs-parity.test.ts.
// That parity gate only catches a string once it has been *wired* through a
// key — it says nothing about a component that never called `t()` in the
// first place. This rule catches that earlier: a literal sentence sitting
// in JSX text or in a human-facing attribute (title, aria-label,
// placeholder, alt, label) instead of behind `t("...")`.
//
// Flags, in .tsx files:
//   - JSXText children with real alphabetic content ("Loading…", "Close")
//     that are not purely punctuation, whitespace, or a single glyph/icon.
//   - String literal values of `title`, `aria-label`, `aria-placeholder`,
//     `placeholder`, `alt` and `label` attributes with real alphabetic
//     content.
//
// Not flagged: anything inside a JSXExpressionContainer (`{t("x")}`,
// `{label}`, `{cwdBasename}`) — this rule only looks at literal text, never
// at what an expression evaluates to. Vendor-reported free text (a model
// name, a raw permission-mode string from an agent) is read from a runtime
// value, not written as a literal here, so it is naturally exempt too.
//
// Existing offenders are listed in untranslated-strings.allowlist.json —
// snapshotted the day this rule shipped, so pre-2.0 UI keeps working
// without a translation sweep blocking unrelated changes. The list only
// shrinks: src/__tests__/lint-no-untranslated-strings.test.ts fails when an
// entry has no more violations or no longer exists. Every *new* file (not
// on the list) is held to the rule from the day it is added — that is the
// "new surfaces" the rule is named for.

const CHECKED_ATTRS = new Set(["title", "aria-label", "aria-placeholder", "placeholder", "alt", "label"]);

// Two-plus letters somewhere = looks like a word, not a bare glyph/number/
// punctuation run ("·", "—", "%", "1", "$12.34", "→").
const LOOKS_LIKE_WORDS = /[A-Za-z]{2,}/;

// A handful of non-sentence tokens that legitimately carry letters:
// units, ISO-ish codes, and single uppercase acronyms shown verbatim.
const ALLOWED_LITERALS = new Set(["px", "ms", "ok", "OK", "UTC", "URL", "ID", "SSH", "CPU", "GB", "MB", "KB"]);

function hasRealWords(raw) {
  const text = String(raw).trim();
  if (!text) return false;
  if (ALLOWED_LITERALS.has(text)) return false;
  return LOOKS_LIKE_WORDS.test(text);
}

function normalise(path) {
  return path.replace(/\\/g, "/");
}

const MESSAGE =
  'New UI surfaces must route user-facing text through t("...") instead of a hardcoded string ({{what}}: "{{text}}"). See eslint-rules/no-untranslated-strings.js.';

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: { description: "Forbid hardcoded user-facing strings in new JSX surfaces" },
    schema: [
      {
        type: "object",
        properties: {
          allowlist: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: { hardcoded: MESSAGE },
  },

  create(context) {
    const options = context.options[0] || {};
    const allowlist = new Set((options.allowlist || []).map(normalise));
    const file = normalise(context.filename);
    const cwd = normalise(context.cwd).replace(/\/+$/, "");
    const relative = file.startsWith(cwd + "/") ? file.slice(cwd.length + 1) : file;
    if (allowlist.has(relative)) return {};

    const report = (node, what, text) => context.report({ node, messageId: "hardcoded", data: { what, text: text.trim().slice(0, 60) } });

    return {
      JSXText(node) {
        if (hasRealWords(node.value)) report(node, "JSX text", node.value);
      },
      JSXAttribute(node) {
        const name = node.name && node.name.type === "JSXIdentifier" ? node.name.name : null;
        if (!name || !CHECKED_ATTRS.has(name)) return;
        const value = node.value;
        if (!value || value.type !== "Literal" || typeof value.value !== "string") return;
        if (hasRealWords(value.value)) report(node, `the "${name}" attribute`, value.value);
      },
    };
  },
};

export default rule;

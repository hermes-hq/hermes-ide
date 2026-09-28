// ESLint rule: no branching on an agent's id outside src/agent/providers.
//
// Hermes is vendor-neutral (docs/adr/003, F19): the status, the inbox, the
// ledger and the plugin API read normalised SessionEvents and capabilities,
// never "is this Claude". Code that must know an agent's quirks lives in
// src/agent/providers/ (or in the catalog data, src/catalog/agents.json).
//
// Flags, outside the providers folder:
//   - comparisons with an agent id: x === "claude", "codex" != y
//   - switch cases on an agent id:  case "gemini":
//   - membership tests with one:    ids.includes("aider"), set.has("goose"),
//                                   id.startsWith("copilot")
//
// The agent ids come from the catalog (the `vendorIds` option, read from
// src/catalog/agents.json by eslint.config.js), so a new catalog entry is
// covered without touching this file. "custom" is not a vendor.
//
// Existing offenders are listed in vendor-id-checks.allowlist.json. The list
// only shrinks: src/__tests__/lint-no-vendor-id-checks.test.ts fails when an
// entry no longer offends or no longer exists.

const MEMBERSHIP = new Set(["includes", "has", "startsWith", "endsWith", "indexOf"]);
const COMPARISON = new Set(["===", "!==", "==", "!="]);

const MESSAGE =
  'Checking for the agent id "{{id}}" outside src/agent/providers. Read the session\'s events or capabilities instead, or move this into a provider. See eslint-rules/no-vendor-id-checks.js.';

function normalise(path) {
  return path.replace(/\\/g, "/");
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: { description: "Forbid branching on an agent's id outside src/agent/providers" },
    schema: [
      {
        type: "object",
        properties: {
          vendorIds: { type: "array", items: { type: "string" } },
          allowlist: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: { vendorCheck: MESSAGE },
  },

  create(context) {
    const options = context.options[0] || {};
    const ids = new Set(options.vendorIds || []);
    const allowlist = new Set((options.allowlist || []).map(normalise));
    const file = normalise(context.filename);
    const cwd = normalise(context.cwd).replace(/\/+$/, "");
    const relative = file.startsWith(cwd + "/") ? file.slice(cwd.length + 1) : file;
    if (relative.startsWith("src/agent/providers/") || allowlist.has(relative)) return {};

    const vendorLiteral = (node) => {
      if (!node) return null;
      if (node.type === "Literal" && typeof node.value === "string" && ids.has(node.value)) return node.value;
      if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
        const text = node.quasis[0]?.value.cooked;
        if (typeof text === "string" && ids.has(text)) return text;
      }
      return null;
    };
    const report = (node, id) => context.report({ node, messageId: "vendorCheck", data: { id } });

    return {
      BinaryExpression(node) {
        if (!COMPARISON.has(node.operator)) return;
        const id = vendorLiteral(node.left) ?? vendorLiteral(node.right);
        if (id) report(node, id);
      },
      SwitchCase(node) {
        const id = vendorLiteral(node.test);
        if (id) report(node, id);
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") return;
        if (!MEMBERSHIP.has(callee.property.name)) return;
        const id = vendorLiteral(node.arguments[0]);
        if (id) report(node, id);
      },
    };
  },
};

export default rule;

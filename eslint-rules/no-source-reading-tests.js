// ESLint rule: tests must not read files.
//
// Tests that read source files and assert on their text pass no matter what
// the code does at runtime. A test must import the code and exercise it.
// Fixtures belong in imports (`import data from "./fixture.json"`), not in
// file reads.
//
// Flags, in test files:
//   - fs read APIs: readFileSync, readFile, createReadStream, openSync,
//     readSync, readdirSync, readdir, opendir, opendirSync — imported
//     from fs / node:fs / fs/promises, or called as `<fs namespace>.<api>`
//   - `?raw` / `?url` imports and `import.meta.glob(..., { query: "?raw" })`
//
// Existing offenders are listed in source-reading-tests.allowlist.json. The
// list only shrinks: src/__tests__/lint-no-source-reading-tests.test.ts
// fails when an entry no longer reads files or no longer exists.

const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const READ_APIS = new Set([
  "readFileSync",
  "readFile",
  "createReadStream",
  "openSync",
  "open",
  "readSync",
  "read",
  "readdirSync",
  "readdir",
  "opendir",
  "opendirSync",
]);
const RAW_QUERY = /\?(raw|url)(&|$)/;

const MESSAGE =
  "Tests must not read files (here: {{what}}). Import the code and test its behaviour; import fixtures instead of reading them. See eslint-rules/no-source-reading-tests.js.";

function normalise(path) {
  return path.replace(/\\/g, "/");
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: { description: "Forbid tests that read files instead of exercising code" },
    schema: [
      {
        type: "object",
        properties: {
          allowlist: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: { noRead: MESSAGE },
  },

  create(context) {
    const options = context.options[0] || {};
    const allowlist = new Set((options.allowlist || []).map(normalise));
    const file = normalise(context.filename);
    const cwd = normalise(context.cwd).replace(/\/+$/, "");
    const relative = file.startsWith(cwd + "/") ? file.slice(cwd.length + 1) : file;
    if (allowlist.has(relative)) return {};

    const fsNamespaces = new Set();
    const report = (node, what) => context.report({ node, messageId: "noRead", data: { what } });

    const checkSource = (node, source) => {
      if (typeof source === "string" && RAW_QUERY.test(source)) report(node, `import "${source}"`);
    };

    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        checkSource(node, source);
        if (!FS_MODULES.has(source)) return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportSpecifier") {
            const name = spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
            if (READ_APIS.has(name)) report(spec, `${name} from "${source}"`);
          } else {
            fsNamespaces.add(spec.local.name);
          }
        }
      },
      ImportExpression(node) {
        if (node.source.type === "Literal") {
          checkSource(node, node.source.value);
          if (FS_MODULES.has(node.source.value)) report(node, `import("${node.source.value}")`);
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        // require("fs")
        if (
          callee.type === "Identifier" &&
          callee.name === "require" &&
          node.arguments[0]?.type === "Literal" &&
          FS_MODULES.has(node.arguments[0].value)
        ) {
          report(node, `require("${node.arguments[0].value}")`);
          return;
        }
        // import.meta.glob("...", { query: "?raw" }) / { as: "raw" }
        if (
          callee.type === "MemberExpression" &&
          callee.object.type === "MetaProperty" &&
          callee.property.type === "Identifier" &&
          callee.property.name.startsWith("glob")
        ) {
          const opts = node.arguments[1];
          if (opts?.type === "ObjectExpression") {
            for (const prop of opts.properties) {
              if (prop.type !== "Property" || prop.value.type !== "Literal") continue;
              const key = prop.key.type === "Identifier" ? prop.key.name : prop.key.value;
              const value = String(prop.value.value);
              if ((key === "query" && RAW_QUERY.test(value)) || (key === "as" && (value === "raw" || value === "url"))) {
                report(node, `import.meta.glob with ${key}: "${value}"`);
              }
            }
          }
          return;
        }
        // fs.readFileSync(...) / fs.promises.readFile(...)
        if (callee.type === "MemberExpression" && callee.property.type === "Identifier" && READ_APIS.has(callee.property.name)) {
          let base = callee.object;
          if (base.type === "MemberExpression" && base.property.type === "Identifier" && base.property.name === "promises") {
            base = base.object;
          }
          if (base.type === "Identifier" && fsNamespaces.has(base.name)) {
            report(node, `${base.name}.${callee.property.name}()`);
          }
        }
      },
    };
  },
};

export default rule;

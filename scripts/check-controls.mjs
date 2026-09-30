#!/usr/bin/env node
// Controls check: buttons, selects and checkboxes come from the control set
// (src/components/ui, docs/design-system/06-components.md · Controls), not
// from a screen's own classes.
//
// It finds three things in src/:
//
//   raw-control   a <button>, <select> or <input type="checkbox"> written in
//                 a .tsx file outside src/components/ui/ — a screen's own
//                 control instead of Button, IconButton, CloseButton, Select,
//                 NativeSelect, Checkbox or Toggle.
//   element-rule  a stylesheet rule outside src/styles/ui/ whose subject is a
//                 button, select or checkbox element (".dialog button {…}"),
//                 i.e. styling a control by the back door.
//   kit-override  a class passed to a control-set component that a
//                 stylesheet outside src/styles/ui/ uses to change how the
//                 control looks (height, padding, colours, border, font…).
//                 Layout (margin, flex, width, position…) is fine.
//   unstyled-raw  a raw control (above) with classes, none of which any
//                 stylesheet names: the rules it was drawn with are gone, so
//                 unless an element rule reaches it, it renders as a bare OS
//                 control. Deleting a migrated screen's CSS while another
//                 screen still uses its classes on raw controls shows here.
//
// The terminal and the code editor draw their own chrome and are allowed
// (ALLOWLIST below). Everything else found today is the migration debt in
// scripts/check-controls-baseline.json: a file may never gain findings of a
// kind, only lose them. When a file loses some, the run says so; shrink the
// baseline with --update.
//
//   node scripts/check-controls.mjs           # exit 1 when a file has more than its baseline
//   node scripts/check-controls.mjs --list    # print every finding, allowed or not
//   node scripts/check-controls.mjs --update  # write today's counts as the baseline

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE_FILE = join(ROOT, "scripts", "check-controls-baseline.json");

/** The control-set components; a class passed to one of them must not restyle it. */
export const KIT_COMPONENTS = new Set([
  "Button",
  "IconButton",
  "CloseButton",
  "Input",
  "Textarea",
  "Select",
  "NativeSelect",
  "Menu",
  "Chip",
  "Segmented",
  "Tabs",
  "Checkbox",
  "Toggle",
  "Radio",
  "RadioGroup",
  "Badge",
  "Counter",
]);

/**
 * Surfaces that keep their own controls: the terminal and the code editor.
 * `file` is a path prefix; `classes`, when given, limits the entry to
 * controls (or rules) carrying one of those classes.
 */
export const ALLOWLIST = [
  { file: "src/components/ui/", reason: "the control set itself" },
  { file: "src/styles/ui/", reason: "the control set itself" },
  { file: "src/styles/base.css", reason: "the global reset every control starts from" },
  { file: "src/editor/", reason: "code editor surface" },
  { file: "src/styles/components/EditorPane.css", reason: "code editor surface" },
  { file: "src/components/TerminalPane.tsx", reason: "terminal surface" },
  { file: "src/styles/components/TerminalPane.css", reason: "terminal surface" },
  { file: "src/components/EmbeddedSlashTerminal.tsx", reason: "terminal surface" },
  { file: "src/styles/components/EmbeddedSlashTerminal.css", reason: "terminal surface" },
  {
    file: "src/components/FilePreviewPanel.tsx",
    classes: ["editor-statusbar-btn", "editor-indent-menu-item"],
    reason: "the code editor's status bar and indentation menu",
  },
  {
    file: "src/styles/components/FilePreview.css",
    classes: ["editor-statusbar-btn", "editor-indent-menu-item"],
    reason: "the code editor's status bar and indentation menu",
  },
];

/** Properties that change how a control looks; a kit control's class may not set them. */
const LOOK_PROPERTIES =
  /^(background(-color|-image)?|color|border(-(top|right|bottom|left))?(-(color|width|style))?|border-radius|border-(top|bottom)-(left|right)-radius|height|min-height|max-height|padding(-(top|right|bottom|left|inline|block)(-(start|end))?)?|font(-(family|size|weight|style))?|line-height|letter-spacing|text-transform|box-shadow|outline(-(color|width|style|offset))?|appearance|-webkit-appearance)$/;

function toPosix(p) {
  return p.split("\\").join("/");
}

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name === "generated") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => name.endsWith(e)) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

export function isAllowed(file, classes = []) {
  return ALLOWLIST.some(
    (a) => file.startsWith(a.file) && (!a.classes || classes.some((c) => a.classes.includes(c))),
  );
}

/** Every static class-name piece inside a className expression. */
function classNamesOf(expr) {
  const out = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      out.push(node.head.text);
      for (const span of node.templateSpans) {
        visit(span.expression);
        out.push(span.literal.text);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expr);
  return out
    .join(" ")
    .split(/\s+/)
    .filter((c) => /^[A-Za-z_][\w-]*$/.test(c));
}

function attr(node, name) {
  return node.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === name);
}

function attrClasses(node) {
  const a = attr(node, "className");
  if (!a || !a.initializer) return [];
  if (ts.isStringLiteral(a.initializer)) return classNamesOf(a.initializer);
  if (ts.isJsxExpression(a.initializer) && a.initializer.expression) return classNamesOf(a.initializer.expression);
  return [];
}

/**
 * The JSX of one .tsx source: its raw controls and the classes it passes to
 * control-set components.
 */
export function scanTsx(source, file = "x.tsx") {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const raw = [];
  const kitClasses = [];
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const classes = attrClasses(node);
      let kind = null;
      if (tag === "button") kind = "button";
      else if (tag === "select") kind = "select";
      else if (tag === "input") {
        const type = attr(node, "type");
        const value =
          type?.initializer && ts.isStringLiteral(type.initializer)
            ? type.initializer.text
            : type?.initializer && ts.isJsxExpression(type.initializer) && type.initializer.expression && ts.isStringLiteral(type.initializer.expression)
              ? type.initializer.expression.text
              : null;
        if (value === "checkbox") kind = "checkbox";
      }
      if (kind) raw.push({ kind, line, classes });
      else if (KIT_COMPONENTS.has(tag) && classes.length) kitClasses.push({ component: tag, line, classes });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { raw, kitClasses };
}

/** The last compound selector of a complex selector (".a > .b:hover" -> ".b:hover"). */
function subjectOf(selector) {
  const parts = selector
    .replace(/\s*([>+~])\s*/g, " ")
    .trim()
    .split(/\s+/);
  return parts[parts.length - 1] || "";
}

const CONTROL_ELEMENT = /^(button|select)(?![\w-])|^input(?![\w-])[^\s]*\[type=["']?checkbox["']?\]/;

/**
 * Rules of one stylesheet: those aimed at a control element, and for every
 * class, whether a rule with that class in its subject changes a look
 * property.
 */
export function scanCss(source) {
  const elementRules = [];
  const lookClasses = new Map(); // class -> first line
  for (const rule of cssRules(source)) {
    if (rule.inKeyframes) continue;
    const look = rule.props.filter((p) => LOOK_PROPERTIES.test(p));
    for (const sel of rule.selectors) {
      const subject = subjectOf(sel);
      // What a :not(…) names is exactly what the rule does not style.
      const positive = subject.replace(/:not\([^)]*\)/g, "");
      const classes = [...positive.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
      if (CONTROL_ELEMENT.test(positive) && rule.props.length) {
        elementRules.push({ line: rule.line, selector: sel, classes });
      }
      if (look.length) {
        for (const c of classes) if (!lookClasses.has(c)) lookClasses.set(c, rule.line);
      }
    }
  }
  return { elementRules, lookClasses };
}

/** Split on commas that are not inside (…) or […]. */
function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * The style rules of a stylesheet, enough for this check: each rule's
 * selectors, the properties it declares, its line, and whether it sits in
 * @keyframes. Comments and strings are skipped; at-rules nest.
 */
export function cssRules(source) {
  // Blank out comments, keeping line breaks so line numbers hold.
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const rules = [];
  const stack = [];
  let line = 1;
  let preludeStart = 0;
  let preludeLine = 1;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") line++;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{") {
      const prelude = text.slice(preludeStart, i).trim();
      if (prelude.startsWith("@")) stack.push({ kind: "at", name: prelude.slice(1).split(/[\s(]/)[0].toLowerCase() });
      else stack.push({ kind: "rule", selectors: splitTopLevel(prelude.replace(/\s+/g, " ")), line: preludeLine, bodyStart: i + 1 });
      preludeStart = i + 1;
      preludeLine = line;
    } else if (ch === "}") {
      const frame = stack.pop();
      if (frame?.kind === "rule") {
        const body = text.slice(frame.bodyStart, i).replace(/\{[^{}]*\}/g, "");
        const props = body
          .split(";")
          .map((d) => d.split(":")[0].trim().toLowerCase())
          .filter((p) => /^-?[a-z][a-z-]*$/.test(p));
        rules.push({ selectors: frame.selectors, props, line: frame.line, inKeyframes: stack.some((f) => f.kind === "at" && /keyframes$/.test(f.name)) });
      }
      preludeStart = i + 1;
      preludeLine = line;
    } else if (ch === ";") {
      preludeStart = i + 1;
      preludeLine = line;
    } else if (/\S/.test(ch) && text.slice(preludeStart, i).trim() === "") {
      preludeLine = line;
    }
  }
  return rules;
}

/** Every class a stylesheet names in any selector (not only a rule's subject). */
export function classesNamedIn(source) {
  const out = new Set();
  for (const rule of cssRules(source)) {
    if (rule.inKeyframes) continue;
    for (const sel of rule.selectors) for (const m of sel.matchAll(/\.([A-Za-z_][\w-]*)/g)) out.add(m[1]);
  }
  return out;
}

/** All findings in the repo (or in `root`), allowed ones marked. */
export function findControls({ root = ROOT } = {}) {
  const src = join(root, "src");
  const findings = [];
  const cssLook = new Map(); // class -> [{file, line}]
  const cssNamed = new Set(); // every class any stylesheet names, anywhere in a selector
  for (const full of walk(src, [".css"])) {
    const file = toPosix(relative(root, full));
    const source = readFileSync(full, "utf8");
    for (const c of classesNamedIn(source)) cssNamed.add(c);
    const { elementRules, lookClasses } = scanCss(source);
    for (const r of elementRules) {
      findings.push({ kind: "element-rule", file, line: r.line, what: r.selector, allowed: isAllowed(file, r.classes) });
    }
    if (file.startsWith("src/styles/ui/")) continue;
    for (const [c, line] of lookClasses) {
      if (!cssLook.has(c)) cssLook.set(c, []);
      cssLook.get(c).push({ file, line });
    }
  }
  for (const full of walk(src, [".tsx"])) {
    const file = toPosix(relative(root, full));
    const { raw, kitClasses } = scanTsx(readFileSync(full, "utf8"), file);
    for (const r of raw) {
      const what = `<${r.kind === "checkbox" ? 'input type="checkbox"' : r.kind}${r.classes.length ? ` class="${r.classes.join(" ")}"` : ""}>`;
      findings.push({ kind: "raw-control", file, line: r.line, what, allowed: isAllowed(file, r.classes) });
      if (r.classes.length && !r.classes.some((c) => cssNamed.has(c))) {
        findings.push({ kind: "unstyled-raw", file, line: r.line, what: `${what}: no stylesheet names these classes`, allowed: isAllowed(file, r.classes) });
      }
    }
    for (const k of kitClasses) {
      for (const c of k.classes) {
        const where = (cssLook.get(c) ?? []).filter((w) => !isAllowed(w.file, [c]));
        if (!where.length) continue;
        findings.push({
          kind: "kit-override",
          file,
          line: k.line,
          what: `<${k.component} className="${c}"> restyled in ${where.map((w) => `${w.file}:${w.line}`).join(", ")}`,
          allowed: isAllowed(file, [c]),
        });
      }
    }
  }
  return findings;
}

/** Counts per kind and file, allowed findings left out. */
export function countFindings(findings) {
  const counts = {};
  for (const f of findings) {
    if (f.allowed) continue;
    counts[f.kind] ??= {};
    counts[f.kind][f.file] = (counts[f.kind][f.file] ?? 0) + 1;
  }
  for (const kind of Object.keys(counts)) {
    counts[kind] = Object.fromEntries(Object.entries(counts[kind]).sort(([a], [b]) => a.localeCompare(b)));
  }
  return counts;
}

/**
 * Compare today's findings to the baseline. `over` fails the check (a file
 * gained findings of a kind); `under` only says the baseline can shrink.
 */
export function compareToBaseline(findings, baseline) {
  const counts = countFindings(findings);
  const over = [];
  const under = [];
  for (const kind of new Set([...Object.keys(counts), ...Object.keys(baseline)])) {
    const now = counts[kind] ?? {};
    const before = baseline[kind] ?? {};
    for (const file of new Set([...Object.keys(now), ...Object.keys(before)])) {
      const n = now[file] ?? 0;
      const b = before[file] ?? 0;
      if (n > b) over.push({ kind, file, now: n, baseline: b, findings: findings.filter((f) => !f.allowed && f.kind === kind && f.file === file) });
      else if (n < b) under.push({ kind, file, now: n, baseline: b });
    }
  }
  return { counts, over, under };
}

function readBaseline() {
  try {
    const raw = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
    delete raw.$comment;
    return raw;
  } catch {
    return {};
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = findControls();
  const args = new Set(process.argv.slice(2));
  if (args.has("--list")) {
    for (const f of findings) console.log(`${f.allowed ? "allowed " : ""}${f.kind}  ${f.file}:${f.line}  ${f.what}`);
  }
  if (args.has("--update")) {
    const counts = countFindings(findings);
    const body = {
      $comment:
        "Controls not yet on the control set (scripts/check-controls.mjs). A file may lose entries, never gain them. Regenerate with node scripts/check-controls.mjs --update.",
      ...counts,
    };
    writeFileSync(BASELINE_FILE, `${JSON.stringify(body, null, 2)}\n`);
    const total = Object.values(counts).reduce((s, m) => s + Object.values(m).reduce((a, b) => a + b, 0), 0);
    console.log(`baseline written: ${total} finding(s) left to migrate`);
    process.exit(0);
  }
  const { counts, over, under } = compareToBaseline(findings, readBaseline());
  for (const o of over) {
    console.error(`${o.file}: ${o.now} ${o.kind} finding(s), baseline allows ${o.baseline}`);
    for (const f of o.findings) console.error(`  ${f.file}:${f.line}  ${f.what}`);
  }
  if (over.length) {
    console.error(
      "\nUse the control set (src/components/ui: Button, IconButton, CloseButton, Select, NativeSelect, Checkbox, Toggle…) instead of a screen's own button, select or checkbox; see docs/design-system/06-components.md · Controls.",
    );
  }
  for (const u of under) console.log(`note: ${u.file} is down to ${u.now} ${u.kind} (baseline ${u.baseline}); run --update to lock that in`);
  const total = Object.values(counts).reduce((s, m) => s + Object.values(m).reduce((a, b) => a + b, 0), 0);
  const allowed = findings.filter((f) => f.allowed).length;
  console.log(`${total} finding(s) left to migrate, ${allowed} allowed (terminal, editor, control set); ${over.length} file(s) over the baseline`);
  process.exit(over.length ? 1 : 0);
}

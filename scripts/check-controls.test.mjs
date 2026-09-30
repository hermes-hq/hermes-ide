import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BASELINE_FILE, classesNamedIn, compareToBaseline, countFindings, findControls, isAllowed, scanCss, scanTsx } from "./check-controls.mjs";

describe("scanTsx", () => {
  it("finds raw buttons, selects and checkboxes, with their classes", () => {
    const { raw } = scanTsx(`
      export function A({ on }: { on: boolean }) {
        return (
          <div>
            <button className="x-btn" onClick={() => {}}>Go</button>
            <button className={\`x-tab\${on ? " x-tab-on" : ""}\`}>Tab</button>
            <select className="x-select"><option>a</option></select>
            <input type="checkbox" checked={on} onChange={() => {}} />
            <input type="text" className="x-field" />
            <input type={"checkbox"} />
          </div>
        );
      }
    `);
    expect(raw.map((r) => [r.kind, r.classes])).toEqual([
      ["button", ["x-btn"]],
      ["button", ["x-tab", "x-tab-on"]],
      ["select", ["x-select"]],
      ["checkbox", []],
      ["checkbox", []],
    ]);
  });

  it("reports the classes given to control-set components, not other components", () => {
    const { raw, kitClasses } = scanTsx(`
      const a = <Button variant="primary" className={cx("save", busy && "saving")}>Save</Button>;
      const b = <Checkbox className="keep" checked label="x" onChange={() => {}} />;
      const c = <Card className="not-a-control" />;
      const d = <Button>plain</Button>;
    `);
    expect(raw).toEqual([]);
    expect(kitClasses.map((k) => [k.component, k.classes])).toEqual([
      ["Button", ["save", "saving"]],
      ["Checkbox", ["keep"]],
    ]);
  });
});

describe("scanCss", () => {
  it("finds rules aimed at control elements, but not what a :not() excludes", () => {
    const { elementRules } = scanCss(`
      .dialog button { padding: 4px; }
      .row > select:focus { border-color: red; }
      .form input[type="checkbox"] { accent-color: blue; }
      .form input:not([type="checkbox"]) { width: 100%; }
      .dialog button-group { display: flex; }
      .dialog .button { color: red; }
    `);
    expect(elementRules.map((r) => r.selector)).toEqual([".dialog button", ".row > select:focus", '.form input[type="checkbox"]']);
  });

  it("marks classes whose rules change a look property, not layout", () => {
    const { lookClasses } = scanCss(`
      .only-layout { margin-left: auto; flex: 1; width: 100%; }
      .looks { background: var(--bg-2); }
      .parent .child:hover { padding: 0 4px; }
      @keyframes spin { from { color: red; } }
    `);
    expect([...lookClasses.keys()].sort()).toEqual(["child", "looks"]);
  });
});

describe("classesNamedIn", () => {
  it("collects every class of every selector, context included, but not keyframe steps", () => {
    const named = classesNamedIn(`
      .a .b > .c:hover, .d { color: red; }
      @media (min-width: 1px) { .e:not(.f) { margin: 0; } }
      @keyframes k { from { opacity: 0; } }
    `);
    expect([...named].sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
});

describe("allowlist", () => {
  it("allows the terminal and the editor, and the editor's own classes only in the file preview", () => {
    expect(isAllowed("src/components/TerminalPane.tsx")).toBe(true);
    expect(isAllowed("src/editor/EditorPane.tsx")).toBe(true);
    expect(isAllowed("src/components/FilePreviewPanel.tsx", ["editor-statusbar-btn"])).toBe(true);
    expect(isAllowed("src/components/FilePreviewPanel.tsx", ["file-preview-back"])).toBe(false);
    expect(isAllowed("src/components/SomeDialog.tsx", ["editor-statusbar-btn"])).toBe(false);
  });
});

describe("findControls on a source tree", () => {
  let root;
  const write = (rel, text) => {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "check-controls-"));
    write("src/components/Dialog.tsx", `export const D = () => (<div><Button className="dlg-ok">OK</Button><button className="dlg-x">x</button></div>);`);
    // A raw button whose stylesheet was deleted (the class is named nowhere any more).
    write("src/components/Orphaned.tsx", `export const O = () => <button className="gone-btn gone-btn-confirm">Kill</button>;`);
    write("src/components/Clean.tsx", `export const C = () => <Button className="clean-ok">OK</Button>;`);
    write("src/components/TerminalPane.tsx", `export const T = () => <button className="term-btn">t</button>;`);
    write("src/components/ui/Button.tsx", `export const B = () => <button className="h-btn" />;`);
    write("src/__tests__/x.test.tsx", `export const X = () => <button className="test-only" />;`);
    write("src/styles/components/Dialog.css", `.dlg-ok { background: red; }\n.dialog-body button { color: red; }\n.clean-ok { margin-left: auto; }\n.dlg .dlg-x:hover { color: red; }\n`);
    write("src/styles/ui/button.css", `.h-btn { background: var(--primary-bg); }\n.x button { color: red; }\n`);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

  it("flags a raw control, a restyled kit class and an element rule; allows the terminal and the kit; skips tests", () => {
    const findings = findControls({ root });
    const flagged = findings.filter((f) => !f.allowed).map((f) => `${f.kind} ${f.file}`);
    expect(flagged.sort()).toEqual(
      [
        "element-rule src/styles/components/Dialog.css",
        "kit-override src/components/Dialog.tsx",
        "raw-control src/components/Dialog.tsx",
        "raw-control src/components/Orphaned.tsx",
        "unstyled-raw src/components/Orphaned.tsx",
      ].sort(),
    );
    expect(findings.find((f) => f.kind === "unstyled-raw").what).toBe('<button class="gone-btn gone-btn-confirm">: no stylesheet names these classes');
    const allowed = findings.filter((f) => f.allowed).map((f) => f.file);
    expect(allowed).toContain("src/components/TerminalPane.tsx");
    expect(allowed).toContain("src/components/ui/Button.tsx");
    expect(findings.some((f) => f.file.includes("__tests__"))).toBe(false);
  });

  it("fails a raw control whose stylesheet was deleted, even when its raw-control count holds", () => {
    const { over } = compareToBaseline(findControls({ root }), {
      "raw-control": { "src/components/Dialog.tsx": 1, "src/components/Orphaned.tsx": 1 },
      "kit-override": { "src/components/Dialog.tsx": 1 },
      "element-rule": { "src/styles/components/Dialog.css": 1 },
    });
    expect(over.map((o) => `${o.kind} ${o.file} ${o.now}>${o.baseline}`)).toEqual(["unstyled-raw src/components/Orphaned.tsx 1>0"]);
  });

  it("fails a file that gains a finding over its baseline and only notes one that lost some", () => {
    const findings = findControls({ root });
    const { over, under } = compareToBaseline(findings, {
      "raw-control": { "src/components/Dialog.tsx": 0, "src/components/Orphaned.tsx": 1 },
      "unstyled-raw": { "src/components/Orphaned.tsx": 1 },
      "kit-override": { "src/components/Dialog.tsx": 1 },
      "element-rule": { "src/styles/components/Dialog.css": 3 },
    });
    expect(over.map((o) => `${o.kind} ${o.file} ${o.now}>${o.baseline}`)).toEqual(["raw-control src/components/Dialog.tsx 1>0"]);
    expect(over[0].findings[0].what).toBe('<button class="dlg-x">');
    expect(under.map((u) => `${u.kind} ${u.file} ${u.now}<${u.baseline}`)).toEqual(["element-rule src/styles/components/Dialog.css 1<3"]);
  });
});

describe("the repository", () => {
  it("has no file above its baseline: new buttons, selects and checkboxes come from the control set", () => {
    const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
    delete baseline.$comment;
    const findings = findControls();
    const { over } = compareToBaseline(findings, baseline);
    expect(over.map((o) => `${o.file}: ${o.findings.map((f) => `${f.line} ${f.what}`).join("; ")}`)).toEqual([]);
  });

  it("the migrated dialogs have no bespoke control left", () => {
    const counts = countFindings(findControls());
    const migrated = [
      "src/components/CloseSessionDialog.tsx",
      "src/components/QuitWithAgentsDialog.tsx",
      "src/components/UpdateDialog.tsx",
      "src/components/PluginUpdateConfirmDialog.tsx",
      "src/components/WhatsNewDialog.tsx",
      "src/components/HandoffDialog.tsx",
      "src/components/BranchConflictDialog.tsx",
      "src/components/DirtyWorktreeDialog.tsx",
      "src/components/FilePreviewPanel.tsx",
      "src/components/PermissionRequestModal.tsx",
      "src/components/ProjectPicker.tsx",
      "src/components/WorkspacePanel.tsx",
      "src/components/ToastContainer.tsx",
      "src/components/PluginManager.tsx",
      "src/components/PluginSettingsForm.tsx",
    ];
    const left = migrated.filter((f) => Object.values(counts).some((byFile) => byFile[f]));
    expect(left).toEqual([]);
  });
});

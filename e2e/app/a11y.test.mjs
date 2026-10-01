// @vitest-environment jsdom
// Behavioural tests for the rig's accessibility audit: real DOM in, the
// violations it reports out. Each rule has a passing and a failing case so
// the audit is shown to be able to fail.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { a11yAudit, auditA11y, auditContrast, contrastAudit } from "./a11y.mjs";

function mount(html) {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
});

const rules = (root) => auditA11y(root).map((v) => v.rule);

describe("auditA11y", () => {
  it("passes a surface whose controls all have names", () => {
    const root = mount(`
      <button>Save</button>
      <button aria-label="Close"><svg></svg></button>
      <button title="Refresh"><svg></svg></button>
      <a href="#x"><img src="x.png" alt="Home"></a>
      <label for="q">Search</label><input id="q">
      <label>Name <input></label>
      <input placeholder="Filter">
      <span id="lbl">Model</span><div role="button" tabindex="0" aria-labelledby="lbl"></div>
      <img src="deco.png" alt="">
      <span class="chip" title="Model: x">x</span>
    `);
    expect(auditA11y(root)).toEqual([]);
  });

  it("flags an icon-only button with no name", () => {
    const root = mount(`<button class="icon-btn"><svg></svg></button>`);
    expect(auditA11y(root)).toEqual([{ rule: "name", element: "button.icon-btn" }]);
  });

  it("flags an unlabelled form field and an unnamed ARIA widget", () => {
    const root = mount(`<input id="n"><div role="switch" tabindex="0"></div>`);
    expect(rules(root)).toEqual(["name", "name"]);
  });

  it("ignores controls nobody can reach (hidden, display:none, aria-hidden)", () => {
    const root = mount(`<button hidden></button><button style="display:none"></button><div aria-hidden="true"><span></span></div>`);
    expect(auditA11y(root)).toEqual([]);
  });

  it("flags an <img> with no alt attribute", () => {
    expect(rules(mount(`<img src="a.png">`))).toEqual(["img-alt"]);
  });

  it("flags a positive tabindex", () => {
    expect(rules(mount(`<span tabindex="3">Jump</span>`))).toEqual(["tabindex"]);
  });

  it("flags focusable content inside aria-hidden", () => {
    expect(rules(mount(`<div aria-hidden="true"><button>Go</button></div>`))).toEqual(["aria-hidden-focus"]);
  });

  it("flags aria-labelledby pointing at an id that does not exist", () => {
    expect(rules(mount(`<section aria-labelledby="missing">x</section>`))).toEqual(["labelledby"]);
  });

  it("reports a missing root instead of passing silently", () => {
    expect(auditA11y(null)).toEqual([{ rule: "root", element: "(no element matched)" }]);
  });

  it("a11yAudit sends a self-contained script that runs the same audit in the page", async () => {
    mount(`<div id="surface"><button></button></div>`);
    let sent;
    const bridge = {
      eval: async (script) => {
        sent = script;
        // What the app does with it: run the body as an async function.
        return new Function(`return (async () => { ${script} })();`)();
      },
    };
    const found = await a11yAudit(bridge, "#surface");
    expect(found).toEqual([{ rule: "name", element: "button" }]);
    expect(sent).toContain('document.querySelector("#surface")');
  });
});

describe("auditContrast", () => {
  // jsdom lays nothing out: every element gets a box so it counts as shown.
  const box = { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON() {} };
  let restore;
  beforeEach(() => {
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = () => box;
    restore = () => (Element.prototype.getBoundingClientRect = original);
  });
  afterEach(() => restore());

  it("passes dark text on white and reports light-blue text on white with its ratio", () => {
    const root = mount(`
      <div style="background-color: rgb(255, 255, 255)">
        <span class="ok" style="color: rgb(58, 58, 60); font-size: 12px">Readable</span>
        <span class="low" style="color: rgb(40, 167, 69); font-size: 11px">Exact status</span>
      </div>`);
    const found = auditContrast(root);
    expect(found.map((f) => f.cls)).toEqual(["low"]);
    expect(found[0].ratio).toBeCloseTo(3.13, 1);
  });

  it("blends a translucent background and the text's opacity", () => {
    const root = mount(`
      <div style="background-color: rgb(255, 255, 255)">
        <span class="faded" style="color: rgb(0, 0, 0); opacity: 0.3; font-size: 12px">Faded</span>
      </div>`);
    expect(auditContrast(root).map((f) => f.cls)).toEqual(["faded"]);
  });

  it("holds large text to 3:1 and skips disabled controls and the terminal", () => {
    const root = mount(`
      <div style="background-color: rgb(255, 255, 255)">
        <span class="big" style="color: rgb(40, 167, 69); font-size: 24px">Large</span>
        <button disabled><span style="color: rgb(200, 200, 200)">Off</span></button>
        <div class="xterm"><span style="color: rgb(250, 250, 250)">prompt</span></div>
      </div>`);
    expect(auditContrast(root)).toEqual([]);
  });

  it("contrastAudit runs the same audit in the page", async () => {
    mount(`<div id="surface" style="background-color: rgb(255, 255, 255)"><span class="low" style="color: rgb(10, 132, 255)">Compose</span></div>`);
    const bridge = { eval: async (script) => new Function(`return (async () => { ${script} })();`)() };
    const found = await contrastAudit(bridge, "#surface");
    expect(found.map((f) => f.cls)).toEqual(["low"]);
  });
});

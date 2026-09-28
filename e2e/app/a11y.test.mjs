// @vitest-environment jsdom
// Behavioural tests for the rig's accessibility audit: real DOM in, the
// violations it reports out. Each rule has a passing and a failing case so
// the audit is shown to be able to fail.
import { afterEach, describe, expect, it } from "vitest";
import { a11yAudit, auditA11y } from "./a11y.mjs";

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

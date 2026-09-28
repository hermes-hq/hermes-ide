// Accessibility checks the real-app rig runs inside the app's webview (F18).
//
// A small, dependency-free stand-in for axe-core's most load-bearing rules,
// so a scenario can assert that a 2.0 surface is usable with a keyboard and
// a screen reader without shipping a 500 KB library into the webview:
//
//   name              every interactive element (button, link, form field,
//                     ARIA widget role, anything in the tab order) has an
//                     accessible name;
//   img-alt           every <img> has an alt attribute (alt="" is fine: it
//                     marks the image decorative);
//   tabindex          no positive tabindex (it hijacks the tab order);
//   aria-hidden-focus nothing inside aria-hidden="true" can take focus;
//   labelledby        every aria-labelledby id resolves to an element.
//
// Not covered here: colour contrast and reduced motion (neither can be
// computed reliably from the DOM of a running webview without driving the
// OS setting), and focus order/visibility, which scenarios prove by
// pressing keys on the CI runners.
//
// `auditA11y` must stay self-contained — `a11yAudit` sends its source text
// into the webview, so it cannot close over anything in this module.

/**
 * Audit `root` and everything under it.
 * @param {Element} root
 * @returns {{ rule: string, element: string }[]} one entry per violation
 */
export function auditA11y(root) {
  const out = [];
  if (!root) return [{ rule: "root", element: "(no element matched)" }];
  const doc = root.ownerDocument;

  const describe = (el) => {
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
    const testid = el.getAttribute("data-testid") ? `[data-testid="${el.getAttribute("data-testid")}"]` : "";
    return `${el.tagName.toLowerCase()}${id}${cls}${testid}`;
  };
  const hiddenFromEveryone = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hasAttribute("hidden")) return true;
      const style = doc.defaultView.getComputedStyle(n);
      if (style.display === "none" || style.visibility === "hidden") return true;
    }
    return false;
  };
  const text = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();
  const labelledByText = (el) =>
    (el.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => doc.getElementById(id))
      .filter(Boolean)
      .map(text)
      .join(" ")
      .trim();
  const accessibleName = (el) => {
    const aria = (el.getAttribute("aria-label") || "").trim();
    if (aria) return aria;
    const byId = labelledByText(el);
    if (byId) return byId;
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "input" && ["button", "submit", "reset"].includes(type) && (el.value || "").trim()) return el.value.trim();
      if (el.id) {
        const forLabel = Array.from(doc.querySelectorAll("label")).find((l) => l.htmlFor === el.id);
        if (forLabel && text(forLabel)) return text(forLabel);
      }
      const wrapping = el.closest("label");
      if (wrapping && text(wrapping)) return text(wrapping);
      const placeholder = (el.getAttribute("placeholder") || "").trim();
      if (placeholder) return placeholder;
    } else {
      const own = text(el);
      if (own) return own;
      const imgAlt = Array.from(el.querySelectorAll("img[alt]"))
        .map((i) => i.getAttribute("alt").trim())
        .filter(Boolean)
        .join(" ");
      if (imgAlt) return imgAlt;
      const svgTitle = el.querySelector("svg title");
      if (svgTitle && text(svgTitle)) return text(svgTitle);
    }
    return (el.getAttribute("title") || "").trim();
  };

  const INTERACTIVE = [
    "button",
    "a[href]",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "summary",
    "[role=button]",
    "[role=link]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=switch]",
    "[role=tab]",
    "[role=menuitem]",
    "[role=option]",
    "[role=combobox]",
    "[role=textbox]",
    "[role=slider]",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  const FOCUSABLE = "button:not([disabled]),a[href],input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1']),[contenteditable=''],[contenteditable=true]";

  const all = [root, ...root.querySelectorAll("*")];
  for (const el of all) {
    if (el.matches(INTERACTIVE) && !hiddenFromEveryone(el) && !el.closest("[aria-hidden=true]") && !accessibleName(el)) {
      out.push({ rule: "name", element: describe(el) });
    }
    if (el.tagName.toLowerCase() === "img" && !el.hasAttribute("alt") && el.getAttribute("role") !== "presentation" && el.getAttribute("aria-hidden") !== "true") {
      out.push({ rule: "img-alt", element: describe(el) });
    }
    const tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && Number(tabindex) > 0) out.push({ rule: "tabindex", element: describe(el) });
    if (el.getAttribute("aria-hidden") === "true") {
      const focusable = [el, ...el.querySelectorAll("*")].find((n) => n.matches(FOCUSABLE));
      if (focusable) out.push({ rule: "aria-hidden-focus", element: describe(focusable) });
    }
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy && labelledBy.split(/\s+/).filter(Boolean).some((id) => !doc.getElementById(id))) {
      out.push({ rule: "labelledby", element: describe(el) });
    }
  }
  return out;
}

/**
 * Run `auditA11y` inside the app on the element `selector` matches.
 * @returns {Promise<{ rule: string, element: string }[]>}
 */
export function a11yAudit(bridge, selector) {
  return bridge.eval(`return (${auditA11y.toString()})(document.querySelector(${JSON.stringify(selector)}));`);
}

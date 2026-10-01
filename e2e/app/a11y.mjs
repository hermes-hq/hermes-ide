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
// Text contrast as painted is `auditContrast` / `contrastAudit` below. Not
// covered here: reduced motion (it cannot be driven without the OS
// setting), and focus order/visibility, which scenarios prove by pressing
// keys on the CI runners.
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

// ─── Text contrast (WCAG AA) ────────────────────────────────────────────
//
// What a person sees on screen, not the tokens (scripts/contrast-audit.mjs
// checks those): every visible text under `root`, its computed colour (with
// the opacity of its ancestors) blended on the solid background it is drawn
// on, against 4.5:1 (3:1 for large text: 24 px, or 18.66 px bold).
// Skipped: the terminal (it paints its own colours), disabled controls
// (exempt, as WCAG allows), text over an image (no single background).
// Self-contained for the same reason as `auditA11y`.

/**
 * Texts under `root` below WCAG AA, lowest ratio first.
 * @param {Element} root
 * @param {number} [limit]
 * @returns {{ text: string, ratio: number, size: number, cls: string }[]}
 */
export function auditContrast(root, limit = 30) {
  if (!root) return [{ text: "(no element matched)", ratio: 0, size: 0, cls: "" }];
  const view = root.ownerDocument.defaultView;
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || "");
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const backgroundOf = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const s = view.getComputedStyle(n);
      if (s.backgroundImage && s.backgroundImage !== "none" && !/gradient/.test(s.backgroundImage)) return null;
      const c = parse(s.backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 1) break;
      }
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) bg = blend(layers[i], bg);
    return bg;
  };
  const opacityOf = (el) => {
    let o = 1;
    for (let n = el; n; n = n.parentElement) o *= Number(view.getComputedStyle(n).opacity);
    return o;
  };
  const out = [];
  const seen = new Set();
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent.trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    if (el.closest(".xterm") || el.closest("button:disabled, [aria-disabled=true]")) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const s = view.getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none") continue;
    const bg = backgroundOf(el);
    let fg = parse(s.color);
    if (!bg || !fg) continue;
    const op = opacityOf(el);
    if (op < 0.1) continue;
    fg = blend({ ...fg, a: fg.a * op }, bg);
    const a = lum(fg);
    const b = lum(bg);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const size = parseFloat(s.fontSize);
    const large = size >= 24 || (Number(s.fontWeight) >= 700 && size >= 18.66);
    if (ratio < (large ? 3 : 4.5)) {
      out.push({ text: text.slice(0, 40), ratio: Math.round(ratio * 100) / 100, size, cls: String(el.className || "").slice(0, 60) });
    }
  }
  return out.sort((x, y) => x.ratio - y.ratio).slice(0, limit);
}

/**
 * Run `auditContrast` inside the app on the element `selector` matches
 * (the whole page when `selector` is null).
 * @returns {Promise<{ text: string, ratio: number, size: number, cls: string }[]>}
 */
export function contrastAudit(bridge, selector = null, limit = 30) {
  const root = selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.body";
  return bridge.eval(`return (${auditContrast.toString()})(${root}, ${Number(limit)});`);
}

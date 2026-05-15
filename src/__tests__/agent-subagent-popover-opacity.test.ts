/**
 * Subagent masthead popover — fully opaque, no backdrop bleed-through.
 *
 * The v1.2.2 release notes already claimed "opaque on every theme", but
 * users still saw the chat behind bleeding through the popover.  The
 * cause was a layered `linear-gradient(--bg-elevated) over --bg-0` plus
 * `backdrop-filter: blur(10px)`.  On some GPU compositors the blur
 * leaked through even when both color tokens were fully opaque hex.
 *
 * All shipped themes define `--bg-elevated` as an opaque hex value, so
 * a single solid fill is both correct and simpler.  These assertions
 * pin the simpler invariant:
 *   1. The popover background is a solid `--bg-elevated` (no gradient).
 *   2. There is NO `backdrop-filter` on the popover.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const CSS_PATH = path.resolve(
  __dirname,
  "../styles/components/agent/AgentSessionView.css",
);

function ruleBody(css: string, selector: string): string {
  // Strip block comments so descriptive prose can't trip our assertions.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = new RegExp(
    selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{",
  );
  const m = stripped.match(re);
  if (!m || m.index === undefined) return "";
  const open = stripped.indexOf("{", m.index);
  let depth = 1;
  for (let i = open + 1; i < stripped.length; i++) {
    if (stripped[i] === "{") depth++;
    else if (stripped[i] === "}") {
      depth--;
      if (depth === 0) return stripped.slice(open + 1, i);
    }
  }
  return "";
}

describe("Subagent popover — background opacity", () => {
  const css = fs.readFileSync(CSS_PATH, "utf-8");
  const body = ruleBody(css, ".agent-subagent-popover");

  it("popover rule exists", () => {
    expect(body.length).toBeGreaterThan(0);
  });

  it("background is a single solid fill, not a layered gradient", () => {
    // Drop linear-gradient(...) entirely so a stray reference in a
    // comment in another rule can't false-positive — but the comment
    // strip above already handles that; this is belt + braces.
    expect(body).not.toMatch(/linear-gradient/);
  });

  it("background uses --bg-elevated (with --bg-1 fallback)", () => {
    expect(body).toMatch(/background:\s*var\(--bg-elevated[^)]*\)/);
  });

  it("does NOT set backdrop-filter — it leaks through on some compositors", () => {
    expect(body).not.toMatch(/backdrop-filter:/);
    expect(body).not.toMatch(/-webkit-backdrop-filter:/);
  });
});

/**
 * Two presentational regressions in the agent session masthead.
 *
 * 1. **Glow not clipped.**  `.agent-session-ticker` has a brass `text-shadow`
 *    that glows symmetrically around the text.  Its parent
 *    `.agent-session-header-title` used to have `overflow: hidden`, which
 *    clipped the bottom 8px of the glow — visible as "Thinking" looking
 *    cut off along the baseline.  The parent overflow rule is now gone;
 *    the leaves (ticker, cwd, model) handle their own truncation.
 *
 * 2. **Single-line ticker.**  When the activity status switched from a
 *    one-word label ("Thinking") to a two-word label ("Running Bash",
 *    "Awaiting Claude"), the ticker could wrap to a second line in narrow
 *    panes — the header would grow vertically and surrounding chips would
 *    visibly jump.  The ticker is now `white-space: nowrap` with ellipsis
 *    so the row height stays constant across state changes.
 *
 * We assert against the stylesheet text itself — there is no behavioural
 * surface to render-test here, and a string match catches accidental
 * reverts cleanly.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const CSS_PATH = path.resolve(
  __dirname,
  "../styles/components/agent/AgentSessionView.css",
);

function readCss(): string {
  // Strip block comments so our string-level assertions don't trip on
  // explanatory prose that happens to mention the same property names
  // (e.g. "No overflow: hidden here — it clips the brass glow").
  return fs
    .readFileSync(CSS_PATH, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Extract a rule body for a given selector heading.  Anchors on
 *  `selector {` (with the brace) so we don't accidentally match a
 *  prefix of a longer selector. */
function ruleBody(css: string, selector: string): string {
  const re = new RegExp(
    selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{",
  );
  const m = css.match(re);
  if (!m || m.index === undefined) return "";
  const open = css.indexOf("{", m.index);
  let depth = 1;
  for (let i = open + 1; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return "";
}

describe("Agent masthead — ticker stability (presentational)", () => {
  it(".agent-session-header-title does NOT clip overflow (would chop the brass glow)", () => {
    const body = ruleBody(readCss(), ".agent-session-header-title");
    expect(body).not.toMatch(/overflow:\s*hidden/);
  });

  it(".agent-session-ticker pins single-line layout with ellipsis", () => {
    const body = ruleBody(readCss(), ".agent-session-ticker");
    expect(body).toMatch(/white-space:\s*nowrap/);
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(body).toMatch(/text-overflow:\s*ellipsis/);
  });

  it(".agent-session-ticker keeps the brass glow", () => {
    const body = ruleBody(readCss(), ".agent-session-ticker");
    // Regression guard — we don't want the fix above to accidentally drop
    // the glow that's the whole point of the brass treatment.
    expect(body).toMatch(/text-shadow:/);
    expect(body).toMatch(/var\(--brass-dim\)/);
  });
});

// @vitest-environment jsdom
/**
 * The bar's fitting settles: when the row is narrower than the width last
 * read for it (it shrank before the observer said so), an overflowing form
 * gives way to the next one instead of being tried again forever.
 */
import { afterEach, describe, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { useBarLayout, type BarLayout } from "../sessionActions/layout";

const seen: BarLayout[] = [];

function Row() {
  const ref = useRef<HTMLDivElement>(null);
  const layout = useBarLayout(ref, "sig", false);
  seen.push(layout);
  return <div ref={ref} data-layout={layout} />;
}

afterEach(() => {
  cleanup();
  seen.length = 0;
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
});

describe("fitting the bar", () => {
  it("moves past a form that overflows even when the width it read is stale", () => {
    // The first read says 900 px; the row is really 700 px wide from then on.
    let reads = 0;
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => (reads++ === 0 ? 900 : 700) });
    // The full form wants 800 px, the glyphs 650.
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.layout === "full" ? 800 : this.dataset.layout === "icons" ? 650 : 300;
      },
    });
    const { container } = render(<Row />);
    expect(container.querySelector("[data-layout]")?.getAttribute("data-layout")).toBe("icons");
    expect(seen.length).toBeLessThan(10);
  });
});

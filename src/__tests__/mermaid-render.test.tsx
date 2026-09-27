// @vitest-environment jsdom
/**
 * Smoke test for the real mermaid render path in <CodeFence>: the lazy
 * import resolves, initialize() accepts our config, and a flowchart comes
 * back as an SVG instead of the error fallback.
 *
 * jsdom has no SVG layout, so the text-measurement APIs mermaid relies on
 * are stubbed with fixed sizes — enough for layout to run to completion.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

import { CodeFence } from "../agent/blocks/CodeFence";

beforeAll(() => {
  const proto = window.SVGElement.prototype as unknown as Record<string, unknown>;
  proto.getBBox = () => ({ x: 0, y: 0, width: 40, height: 16 });
  proto.getComputedTextLength = () => 40;
});

afterEach(() => cleanup());

describe("mermaid rendering", () => {
  it("renders a flowchart fence to SVG", async () => {
    const { container } = render(
      <CodeFence language="mermaid" code={"graph TD\n  A[Start] --> B[End]"} />,
    );
    await waitFor(
      () => {
        expect(container.querySelector(".agent-code-fence-mermaid-error")).toBeNull();
        expect(container.querySelector(".agent-code-fence-mermaid-body svg")).not.toBeNull();
      },
      { timeout: 10000 },
    );
    const svg = container.querySelector(".agent-code-fence-mermaid-body svg")!;
    expect(svg.textContent).toContain("Start");
    expect(svg.textContent).toContain("End");
  });
});

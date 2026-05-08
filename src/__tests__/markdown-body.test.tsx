/**
 * Tests for the assistant text markdown renderer.
 *
 * Verifies the GFM features the user explicitly cares about — tables, code
 * fences, lists, headings, links — produce the expected DOM shape with our
 * editorial-engineering classes attached.  Heavy DOM rendering (mermaid,
 * highlight.js) is exercised at the integration level; here we just confirm
 * the structural skeleton.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownBody } from "../agent/blocks/MarkdownBody";

const html = (source: string) =>
  renderToStaticMarkup(<MarkdownBody source={source} />);

describe("<MarkdownBody> — paragraphs and inline formatting", () => {
  it("renders a paragraph with the agent-md-p class", () => {
    expect(html("hello world")).toContain('class="agent-md-p"');
  });

  it("renders bold and italic", () => {
    const out = html("**bold** and _italic_");
    expect(out).toMatch(/<strong>bold<\/strong>/);
    expect(out).toMatch(/<em>italic<\/em>/);
  });

  it("renders inline code with the inline-code class", () => {
    const out = html("call `foo()` to start");
    expect(out).toContain('class="agent-md-code-inline"');
    expect(out).toContain("foo()");
  });

  it("opens links in a new tab and applies the link class", () => {
    const out = html("[anthropic](https://anthropic.com)");
    expect(out).toContain('class="agent-md-link"');
    expect(out).toContain('href="https://anthropic.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noreferrer noopener"');
  });
});

describe("<MarkdownBody> — block elements", () => {
  it("renders headings with the right classes", () => {
    const out = html("# Title\n\n## Sub\n\n### Section");
    expect(out).toContain('class="agent-md-h1"');
    expect(out).toContain('class="agent-md-h2"');
    expect(out).toContain('class="agent-md-h3"');
  });

  it("renders unordered lists", () => {
    const out = html("- one\n- two\n- three");
    expect(out).toContain('class="agent-md-ul"');
    expect(out).toContain('class="agent-md-li"');
    expect(out).toContain("one");
    expect(out).toContain("three");
  });

  it("renders ordered lists", () => {
    const out = html("1. first\n2. second");
    expect(out).toContain('class="agent-md-ol"');
    expect(out).toMatch(/first/);
    expect(out).toMatch(/second/);
  });

  it("renders blockquotes", () => {
    const out = html("> quoted text");
    expect(out).toContain('class="agent-md-blockquote"');
    expect(out).toContain("quoted text");
  });

  it("renders horizontal rules", () => {
    expect(html("a\n\n---\n\nb")).toContain('class="agent-md-hr"');
  });
});

describe("<MarkdownBody> — GFM features", () => {
  it("renders tables wrapped in a scroll container", () => {
    const md = `| col-a | col-b |\n|-------|-------|\n| one   | two   |`;
    const out = html(md);
    expect(out).toContain('class="agent-md-table-wrap"');
    expect(out).toContain('class="agent-md-table"');
    expect(out).toContain("col-a");
    expect(out).toContain("two");
  });

  it("renders strikethrough", () => {
    const out = html("~~old~~ new");
    expect(out).toMatch(/<del>old<\/del>/);
  });

  it("renders task lists with checkboxes", () => {
    const out = html("- [ ] todo\n- [x] done");
    expect(out).toContain('type="checkbox"');
    expect(out).toContain("todo");
    expect(out).toContain("done");
  });
});

describe("<MarkdownBody> — code fences", () => {
  it("routes fenced code with a language to CodeFence", () => {
    const out = html("```ts\nconst x = 1;\n```");
    expect(out).toContain("agent-code-fence");
    expect(out).toContain('data-language="ts"');
  });

  it("routes mermaid fences to the mermaid renderer", () => {
    const out = html("```mermaid\ngraph TD; A-->B;\n```");
    // Mermaid renders its body asynchronously; the static markup is the
    // header skeleton with the language pill.
    expect(out).toContain("agent-code-fence-mermaid");
    expect(out).toContain("mermaid");
  });

  it("preserves multi-line code without the language hint", () => {
    const out = html("```\nline one\nline two\n```");
    expect(out).toContain("agent-code-fence");
    expect(out).toContain("line one");
    expect(out).toContain("line two");
  });
});

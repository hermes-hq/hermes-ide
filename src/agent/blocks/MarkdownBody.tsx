import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeFence } from "./CodeFence";

interface MarkdownBodyProps {
  source: string;
}

/**
 * Renders Claude's assistant text as full GitHub-flavored markdown.
 *
 * Renders headings, paragraphs, lists, blockquotes, links, inline code,
 * bold/italic, hrs, and GFM tables / strikethrough / task lists.  Fenced
 * code blocks are routed to <CodeFence>, which adds syntax highlighting,
 * a language pill, and a copy button.  Mermaid fences are lazy-loaded.
 *
 * Component renderers are passed inline (no `useMemo`) — react-markdown
 * stable-references its own AST nodes and the closures here are pure, so
 * React does the right thing without extra memoization.  The whole body
 * is `memo`'d on `source` so unchanged turns don't reparse during scroll.
 */
export const MarkdownBody = memo(function MarkdownBody({ source }: MarkdownBodyProps) {
  return (
    <div className="agent-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Code: distinguish inline from fenced.  In react-markdown v9+ the
          // `inline` prop was removed — we detect inline by the absence of a
          // newline, which matches how remark parses inline code.
          code({ className, children, ...props }) {
            const text = String(children ?? "");
            const isFenced = text.includes("\n") || /language-/.test(className ?? "");
            if (isFenced) {
              const match = /language-([\w+-]+)/.exec(className ?? "");
              const language = match ? match[1] : null;
              const body = text.replace(/\n$/, "");
              return <CodeFence code={body} language={language} />;
            }
            return (
              <code className="agent-md-code-inline" {...props}>{children}</code>
            );
          },
          // Tables: wrap in a scroll container so wide tables don't blow out
          // the column.  The wrapper provides horizontal overflow without the
          // table itself losing its sticky-header behavior.
          table({ children }) {
            return (
              <div className="agent-md-table-wrap">
                <table className="agent-md-table">{children}</table>
              </div>
            );
          },
          a({ href, children, ...props }) {
            return (
              <a
                className="agent-md-link"
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                {...props}
              >
                {children}
              </a>
            );
          },
          blockquote({ children }) {
            return <blockquote className="agent-md-blockquote">{children}</blockquote>;
          },
          h1: ({ children }) => <h1 className="agent-md-h1">{children}</h1>,
          h2: ({ children }) => <h2 className="agent-md-h2">{children}</h2>,
          h3: ({ children }) => <h3 className="agent-md-h3">{children}</h3>,
          h4: ({ children }) => <h4 className="agent-md-h4">{children}</h4>,
          ul: ({ children }) => <ul className="agent-md-ul">{children}</ul>,
          ol: ({ children }) => <ol className="agent-md-ol">{children}</ol>,
          li: ({ children, ...props }) => <li className="agent-md-li" {...props}>{children}</li>,
          hr: () => <hr className="agent-md-hr" />,
          p: ({ children }) => <p className="agent-md-p">{children}</p>,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});

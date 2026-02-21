import "../styles/components/SplitPane.css";
import { LayoutNode } from "../state/layoutTypes";
import { SplitPane } from "./SplitPane";
import { SplitDivider } from "./SplitDivider";

interface SplitLayoutProps {
  node: LayoutNode;
}

export function SplitLayout({ node }: SplitLayoutProps) {
  if (node.type === "pane") {
    return <SplitPane paneId={node.id} sessionId={node.sessionId} />;
  }

  const isH = node.direction === "horizontal";

  return (
    <div
      className="split-container"
      style={{ flexDirection: isH ? "row" : "column" }}
    >
      <div
        className="split-child"
        style={{ flex: `0 0 calc(${node.ratio * 100}% - 1.5px)`, overflow: "hidden" }}
      >
        <SplitLayout node={node.children[0]} />
      </div>
      <SplitDivider splitId={node.id} direction={node.direction} />
      <div className="split-child" style={{ flex: 1, overflow: "hidden" }}>
        <SplitLayout node={node.children[1]} />
      </div>
    </div>
  );
}

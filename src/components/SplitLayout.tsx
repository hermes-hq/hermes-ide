import "../styles/components/SplitPane.css";
import { LayoutNode } from "../state/layoutTypes";
import { SplitPane } from "./SplitPane";
import { SplitDivider } from "./SplitDivider";
import { ContainedErrorBoundary } from "./ContainedErrorBoundary";
import { useSession } from "../state/SessionContext";
import { translate } from "../i18n/registry";
import { Button } from "./ui";

interface SplitLayoutProps {
  node: LayoutNode;
}

export function SplitLayout({ node }: SplitLayoutProps) {
  if (node.type === "pane") {
    return <ContainedPane paneId={node.id} sessionId={node.sessionId} />;
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

/** One pane, fenced off so a crash in its header or body cannot take the
 *  other panes (or the rest of the window) down with it. SplitPane adds a
 *  second, inner fence around the pane body that keeps the header usable;
 *  both show the same card. */
function ContainedPane({ paneId, sessionId }: { paneId: string; sessionId: string }) {
  const { state, dispatch } = useSession();
  return (
    <ContainedErrorBoundary
      key={sessionId}
      scope="pane"
      label={state.sessions[sessionId]?.label}
      actions={
        <Button onClick={() => dispatch({ type: "CLOSE_PANE", paneId })}>
          {translate("crash.closePane")}
        </Button>
      }
    >
      <SplitPane paneId={paneId} sessionId={sessionId} />
    </ContainedErrorBoundary>
  );
}

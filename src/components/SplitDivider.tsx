import "../styles/components/SplitPane.css";
import { useCallback, useRef } from "react";
import { SplitDirection } from "../state/layoutTypes";
import { useSession } from "../state/SessionContext";
import { refitActive } from "../terminal/TerminalPool";

interface SplitDividerProps {
  splitId: string;
  direction: SplitDirection;
}

export function SplitDivider({ splitId, direction }: SplitDividerProps) {
  const { dispatch } = useSession();
  const rafRef = useRef<number | null>(null);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const parent = (e.target as HTMLElement).parentElement;
      if (!parent) return;

      const rect = parent.getBoundingClientRect();
      const isH = direction === "horizontal";

      document.body.style.cursor = isH ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";

      const onMouseMove = (ev: MouseEvent) => {
        if (rafRef.current !== null) return;
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          const pos = isH ? ev.clientX - rect.left : ev.clientY - rect.top;
          const size = isH ? rect.width : rect.height;
          if (size <= 0) return; // Avoid NaN/Infinity from division by zero
          const ratio = pos / size;
          dispatch({ type: "RESIZE_SPLIT", splitId, ratio });
        });
      };

      const onMouseUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        refitActive();
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [splitId, direction, dispatch],
  );

  return (
    <div
      className={`split-divider split-divider-${direction}`}
      onMouseDown={onMouseDown}
    />
  );
}

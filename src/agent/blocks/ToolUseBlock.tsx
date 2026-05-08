import type { ToolResultBlockData, ToolUseBlockData } from "../types";
import { ExecToolBlock } from "./ExecToolBlock";
import { FileToolBlock } from "./FileToolBlock";
import { GenericToolBlock } from "./GenericToolBlock";
import { SearchToolBlock } from "./SearchToolBlock";
import { WebToolBlock } from "./WebToolBlock";
import { getToolFamily } from "./getToolFamily";

interface ToolUseBlockProps {
  block: ToolUseBlockData;
  result: ToolResultBlockData | undefined;
}

/**
 * Thin router. Dispatches to one of five family-specific renderers based on
 * the tool name. See playbook §5 and `getToolFamily.ts`.
 */
export function ToolUseBlock({ block, result }: ToolUseBlockProps) {
  const family = getToolFamily(block.name);
  switch (family) {
    case "file":
      return <FileToolBlock block={block} result={result} />;
    case "exec":
      return <ExecToolBlock block={block} result={result} />;
    case "search":
      return <SearchToolBlock block={block} result={result} />;
    case "web":
      return <WebToolBlock block={block} result={result} />;
    case "generic":
    default:
      return <GenericToolBlock block={block} result={result} />;
  }
}

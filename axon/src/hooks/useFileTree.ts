import { useMemo } from "react";

export interface FileTreeNode {
  name: string;
  path: string;
  children: FileTreeNode[];
  isFile: boolean;
}

function buildTree(files: string[]): FileTreeNode[] {
  const root: FileTreeNode = { name: "", path: "", children: [], isFile: false };

  for (const filePath of files) {
    const parts = filePath.split("/").filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const partPath = "/" + parts.slice(0, i + 1).join("/");

      let child = current.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, path: partPath, children: [], isFile: isLast };
        current.children.push(child);
      }
      current = child;
    }
  }

  // Sort: directories first, then alphabetically
  function sortTree(nodes: FileTreeNode[]): FileTreeNode[] {
    for (const node of nodes) {
      if (node.children.length > 0) {
        node.children = sortTree(node.children);
      }
    }
    return nodes.sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  }

  return sortTree(root.children);
}

// Collapse single-child directories (e.g. src/components -> src/components)
function collapse(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.map((node) => {
    if (!node.isFile && node.children.length === 1 && !node.children[0].isFile) {
      const child = node.children[0];
      return {
        ...child,
        name: `${node.name}/${child.name}`,
        children: collapse(child.children),
      };
    }
    return { ...node, children: collapse(node.children) };
  });
}

export function useFileTree(files: string[]): FileTreeNode[] {
  return useMemo(() => collapse(buildTree(files)), [files]);
}

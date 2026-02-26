import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import type { FileEntry } from "../types/git";
import { listDirectory } from "../api/git";

// ─── Legacy FileTreeNode (used by ContextPanel) ──────────────────────

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

/** Legacy hook for ContextPanel (builds tree from file paths) */
export function useFileTree(files: string[]): FileTreeNode[] {
  return useMemo(() => collapse(buildTree(files)), [files]);
}

// ─── Pure helpers for File Explorer (exported for testing) ────────────

export function buildTreePath(parentPath: string, name: string): string {
  if (!name) return parentPath;
  if (!parentPath) return name;
  const clean = parentPath.endsWith("/") ? parentPath.slice(0, -1) : parentPath;
  return `${clean}/${name}`;
}

export function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

export function filterEntries(entries: FileEntry[], query: string, showHidden: boolean): FileEntry[] {
  let filtered = entries;
  if (!showHidden) {
    filtered = filtered.filter((e) => !e.is_hidden);
  }
  if (query.trim()) {
    const q = query.toLowerCase();
    filtered = filtered.filter((e) => e.name.toLowerCase().includes(q));
  }
  return filtered;
}

// ─── File Explorer Hook (lazy-loading directory tree) ─────────────────

export function useFileExplorer(projectPath: string | null) {
  const [cache, setCache] = useState<Map<string, FileEntry[]>>(new Map());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const expandedDirsRef = useRef(expandedDirs);
  expandedDirsRef.current = expandedDirs;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Clear stale state when projectPath changes
  useEffect(() => {
    setCache(new Map());
    setExpandedDirs(new Set());
    setLoadingDirs(new Set());
    setError(null);
  }, [projectPath]);

  const loadDirectory = useCallback(async (relativePath: string) => {
    if (!projectPath) return;
    setLoadingDirs((prev) => new Set(prev).add(relativePath));
    try {
      const entries = await listDirectory(projectPath, relativePath || undefined);
      if (!mounted.current) return;
      setCache((prev) => {
        const next = new Map(prev);
        next.set(relativePath, entries);
        return next;
      });
      setError(null);
    } catch (e) {
      if (!mounted.current) return;
      setError(String(e));
    } finally {
      if (mounted.current) {
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(relativePath);
          return next;
        });
      }
    }
  }, [projectPath]);

  const toggleDir = useCallback((relativePath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(relativePath)) {
        next.delete(relativePath);
      } else {
        next.add(relativePath);
        // Use ref to read the LATEST cache, avoiding stale closure
        if (!cacheRef.current.has(relativePath)) {
          loadDirectory(relativePath);
        }
      }
      return next;
    });
  }, [loadDirectory]);

  const refresh = useCallback(() => {
    setCache(new Map());
    setError(null);
    loadDirectory("");
    // Use ref to read the LATEST expandedDirs, avoiding stale closure
    expandedDirsRef.current.forEach((dir) => {
      if (dir) loadDirectory(dir);
    });
  }, [loadDirectory]);

  const getEntries = useCallback((relativePath: string): FileEntry[] | null => {
    return cache.get(relativePath) ?? null;
  }, [cache]);

  return {
    expandedDirs,
    loadingDirs,
    error,
    loadDirectory,
    toggleDir,
    refresh,
    getEntries,
  };
}

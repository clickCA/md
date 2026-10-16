import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Trash2 } from "lucide-react";

interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  children?: TreeNode[];
}

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", dir: true, children: [] };
  for (const p of [...paths].sort()) {
    const parts = p.split("/");
    let cur = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      const full = parts.slice(0, i + 1).join("/");
      let next = cur.children!.find((c) => c.name === part && c.dir === !isFile);
      if (!next) {
        next = {
          name: part,
          path: full,
          dir: !isFile,
          children: isFile ? undefined : [],
        };
        cur.children!.push(next);
      }
      cur = next;
    });
  }
  const sortRec = (n: TreeNode) => {
    n.children?.sort((a, b) =>
      a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1,
    );
    n.children?.forEach(sortRec);
  };
  sortRec(root);
  return root.children!;
}

interface Props {
  notes: string[];
  activeNote: string | null;
  onPick: (path: string) => void;
  onDelete: (path: string) => void;
  /** touch targets: show delete without hover (mobile drawer) */
  alwaysShowDelete?: boolean;
}

export default function FileTree({
  notes,
  activeNote,
  onPick,
  onDelete,
  alwaysShowDelete,
}: Props) {
  const tree = useMemo(() => buildTree(notes), [notes]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderNodes = (nodes: TreeNode[], depth: number) =>
    nodes.map((node) => {
      if (node.dir) {
        const open = expanded.has(node.path);
        return (
          <div key={`d:${node.path}`}>
            <button
              onClick={() => toggle(node.path)}
              className="flex w-full items-center gap-1.5 py-1.5 text-left text-sm text-text-2 hover:bg-surface-2"
              style={{ paddingLeft: `${12 + depth * 14}px` }}
            >
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {open ? (
                <FolderOpen size={14} className="text-accent" />
              ) : (
                <Folder size={14} className="text-accent" />
              )}
              <span className="truncate">{node.name}</span>
            </button>
            {open && node.children && renderNodes(node.children, depth + 1)}
          </div>
        );
      }
      return (
        <div key={`f:${node.path}`} className="group flex items-center">
          <button
            onClick={() => onPick(node.path)}
            className={
              "flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-sm hover:bg-surface-2 " +
              (node.path === activeNote ? "font-medium text-accent" : "")
            }
            style={{ paddingLeft: `${12 + depth * 14 + 14}px` }}
          >
            <FileText size={13} className="shrink-0 text-text-2" />
            <span className="truncate">{node.name}</span>
          </button>
          <button
            onClick={() => onDelete(node.path)}
            className={
              "mr-1 rounded p-1 text-text-2 hover:text-danger " +
              (alwaysShowDelete ? "block" : "hidden group-hover:block")
            }
            title="delete"
          >
            <Trash2 size={12} />
          </button>
        </div>
      );
    });

  if (tree.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-text-2">no notes yet</div>
    );
  }
  return <div className="min-h-0 flex-1 overflow-y-auto pr-1">{renderNodes(tree, 0)}</div>;
}

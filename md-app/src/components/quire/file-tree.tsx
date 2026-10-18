import { type DragEvent, type ReactNode, useState } from "react";
import { ChevronRight, FilePlus, FolderOpen, FolderPlus } from "lucide-react";
import { type GitStatus, type TreeNode, type VaultFile, buildTree, parentOf, statusOf } from "@/lib/vault";
import { cn } from "@/lib/utils";
import { PanelHeader } from "./panel-header";

const DRAG_TYPE = "application/x-quire-path";
const ROOT = "\u0000root";

type Props = {
  files: VaultFile[];
  folders: string[];
  showStatus: boolean;
  active: string | null;
  onOpen: (path: string) => void;
  onCreate: () => void;
  onCreateFolder: () => void;
  onOpenFolder: () => void;
  onMove: (from: string, toFolder: string) => void;
};

export function FileTree({
  files,
  folders,
  showStatus,
  active,
  onOpen,
  onCreate,
  onCreateFolder,
  onOpenFolder,
  onMove,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const statuses = new Map(files.map((f) => [f.path, showStatus ? statusOf(f) : "clean"]));
  const tree = buildTree(files, folders);

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const canDrop = (folder: string) => {
    if (!dragging) return true;
    if (parentOf(dragging) === folder) return false;
    return folder !== dragging && !folder.startsWith(`${dragging}/`);
  };

  const dnd = {
    dragging,
    dropTarget,
    onDragStart: (path: string, e: DragEvent) => {
      e.dataTransfer.setData(DRAG_TYPE, path);
      e.dataTransfer.effectAllowed = "move";
      setDragging(path);
    },
    onDragEnd: () => {
      setDragging(null);
      setDropTarget(null);
    },
    onDragOver: (folder: string, e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!canDrop(folder)) {
        e.dataTransfer.dropEffect = "none";
        setDropTarget(null);
        return;
      }
      e.dataTransfer.dropEffect = "move";
      setDropTarget(folder || ROOT);
    },
    onDrop: (folder: string, e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const from = e.dataTransfer.getData(DRAG_TYPE);
      setDropTarget(null);
      setDragging(null);
      if (from && canDrop(folder)) onMove(from, folder);
    },
  };

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Vault">
        <HeaderButton label="New note" onClick={onCreate}>
          <FilePlus className="size-3.5" aria-hidden />
        </HeaderButton>
        <HeaderButton label="New folder" onClick={onCreateFolder}>
          <FolderPlus className="size-3.5" aria-hidden />
        </HeaderButton>
        <HeaderButton label="Open folder" onClick={onOpenFolder}>
          <FolderOpen className="size-3.5" aria-hidden />
        </HeaderButton>
      </PanelHeader>
      <ul
        role="tree"
        aria-label="Notes"
        onDragOver={(e) => dnd.onDragOver("", e)}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null);
        }}
        onDrop={(e) => dnd.onDrop("", e)}
        className={cn(
          "flex-1 overflow-y-auto rounded-md px-1.5 pb-4 transition-colors",
          dropTarget === ROOT && "bg-primary/5 outline outline-1 -outline-offset-1 outline-primary/40",
        )}
      >
        {tree.map((node) => (
          <Node
            key={node.path}
            node={node}
            depth={0}
            active={active}
            collapsed={collapsed}
            statuses={statuses}
            onToggle={toggle}
            onOpen={onOpen}
            dnd={dnd}
          />
        ))}
        {tree.length === 0 ? (
          <li className="px-3 py-6 text-center text-xs leading-relaxed text-muted-foreground">
            No notes yet. Create one to get started.
          </li>
        ) : (
          dragging && (
            <li
              aria-hidden
              className="mx-1 mt-2 rounded-md border border-dashed border-border py-2 text-center text-[11px] text-muted-foreground"
            >
              Drop here to move to vault root
            </li>
          )
        )}
      </ul>
    </div>
  );
}

function HeaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

type Dnd = {
  dragging: string | null;
  dropTarget: string | null;
  onDragStart: (path: string, e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (folder: string, e: DragEvent) => void;
  onDrop: (folder: string, e: DragEvent) => void;
};

type NodeProps = {
  node: TreeNode;
  depth: number;
  active: string | null;
  collapsed: Set<string>;
  statuses: Map<string, GitStatus>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  dnd: Dnd;
};

function Node({ node, depth, active, collapsed, statuses, onToggle, onOpen, dnd }: NodeProps) {
  const indent = { paddingLeft: `${depth * 12 + 6}px` };
  const isDragging = dnd.dragging === node.path;
  const drag = {
    draggable: true,
    onDragStart: (e: DragEvent) => dnd.onDragStart(node.path, e),
    onDragEnd: dnd.onDragEnd,
  };

  if (node.type === "folder") {
    const open = !collapsed.has(node.path);
    const isTarget = dnd.dropTarget === node.path;
    return (
      <li
        role="treeitem"
        aria-expanded={open}
        aria-selected={false}
        onDragOver={(e) => dnd.onDragOver(node.path, e)}
        onDrop={(e) => dnd.onDrop(node.path, e)}
        className={cn("rounded-md", isTarget && "bg-primary/10 outline outline-1 -outline-offset-1 outline-primary/50")}
      >
        <button
          type="button"
          {...drag}
          onClick={() => onToggle(node.path)}
          style={indent}
          className={cn(
            "flex h-7 w-full items-center gap-1 rounded-md pr-2 text-left text-[13px] text-sidebar-foreground hover:bg-sidebar-accent",
            isDragging && "opacity-40",
          )}
        >
          <ChevronRight
            className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
            aria-hidden
          />
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children.length > 0 && (
          <ul role="group">
            {node.children.map((child) => (
              <Node
                key={child.path}
                node={child}
                depth={depth + 1}
                active={active}
                collapsed={collapsed}
                statuses={statuses}
                onToggle={onToggle}
                onOpen={onOpen}
                dnd={dnd}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const status = statuses.get(node.path) ?? "clean";
  const isActive = active === node.path;
  const parent = parentOf(node.path);
  return (
    <li role="treeitem" aria-selected={isActive}>
      <button
        type="button"
        {...drag}
        onClick={() => onOpen(node.path)}
        onDragOver={(e) => dnd.onDragOver(parent, e)}
        onDrop={(e) => dnd.onDrop(parent, e)}
        style={indent}
        className={cn(
          "flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[13px] text-sidebar-foreground hover:bg-sidebar-accent",
          isActive && "bg-sidebar-accent text-sidebar-accent-foreground",
          isDragging && "opacity-40",
        )}
      >
        <span className="ml-5 truncate">{node.name}</span>
        {status !== "clean" && (
          <span
            className={cn(
              "ml-auto size-1.5 shrink-0 rounded-full",
              status === "modified" ? "bg-modified" : "bg-added",
            )}
            title={status === "modified" ? "Changed since last commit" : "New note, not committed"}
          />
        )}
      </button>
    </li>
  );
}

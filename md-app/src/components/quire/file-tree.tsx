import { type DragEvent, type ReactNode, useMemo, useState } from "react";
import { ChevronRight, FilePlus, FolderOpen, FolderPlus } from "lucide-react";
import { ContextMenu } from "@base-ui/react/context-menu";
import {
  type GitStatus,
  type TreeNode,
  type VaultFile,
  buildTree,
  parentOf,
  statusOf,
} from "@/lib/vault";
import { cn } from "@/lib/utils";
import { PanelHeader } from "./panel-header";

const DRAG_TYPE = "application/x-quire-path";
const ROOT = "\u0000root";

const menuItemCls =
  "flex cursor-default items-center rounded-sm px-2 py-1 text-[13px] outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

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
  onDelete: (path: string) => void;
  onReveal: (path: string) => void;
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
  onDelete,
  onReveal,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  // Row targeted by the last right-click; the shared menu reads it when open.
  const [menuPath, setMenuPath] = useState<string | null>(null);
  // Typing re-creates the `files` array (the edited note object) on every
  // keystroke, but paths and git statuses only change on save/refresh — key
  // the tree and status map on that content-independent signature so
  // keystrokes never rebuild the tree.
  const pathSig = files.map((f) => f.path).join("\n");
  const statusSig = files.map((f) => (showStatus ? statusOf(f) : "clean")).join("\n");
  const statuses = useMemo(
    () => new Map(files.map((f) => [f.path, showStatus ? statusOf(f) : "clean"] as const)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- derived signature, not identity
    [pathSig, statusSig, showStatus],
  );
  const folderSig = folders.join("\n");
  const tree = useMemo(
    () => buildTree(files, folders),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- derived signature, not identity
    [pathSig, folderSig],
  );

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
      <ContextMenu.Root>
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
            dropTarget === ROOT &&
              "bg-primary/5 outline outline-1 -outline-offset-1 outline-primary/40",
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
              onMenuTarget={setMenuPath}
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
        <ContextMenu.Portal>
          <ContextMenu.Positioner sideOffset={6} className="z-50 outline-none">
            <ContextMenu.Popup className="min-w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg">
              <ContextMenu.Item
                className={menuItemCls}
                onClick={() => menuPath && onOpen(menuPath)}
              >
                Open
              </ContextMenu.Item>
              <ContextMenu.Item
                className={menuItemCls}
                onClick={() => menuPath && onReveal(menuPath)}
              >
                Reveal in file manager
              </ContextMenu.Item>
              <ContextMenu.Separator className="mx-2 my-1 h-px bg-border" />
              <ContextMenu.Item
                className={cn(
                  menuItemCls,
                  "text-destructive data-[highlighted]:bg-destructive data-[highlighted]:text-destructive-foreground",
                )}
                onClick={() => menuPath && onDelete(menuPath)}
              >
                Delete
              </ContextMenu.Item>
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </div>
  );
}

function HeaderButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
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
  onMenuTarget: (path: string) => void;
  dnd: Dnd;
};

function Node({
  node,
  depth,
  active,
  collapsed,
  statuses,
  onToggle,
  onOpen,
  onMenuTarget,
  dnd,
}: NodeProps) {
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
        className={cn(
          "rounded-md",
          isTarget && "bg-primary/10 outline outline-1 -outline-offset-1 outline-primary/50",
        )}
      >
        <button
          type="button"
          {...drag}
          onClick={() => onToggle(node.path)}
          style={indent}
          className={cn(
            "flex h-7 w-full items-center gap-1 rounded-md pr-2 text-left text-[13px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60",
            isDragging && "opacity-40",
          )}
        >
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
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
                onMenuTarget={onMenuTarget}
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
      {/* The trigger merges onto the row button, so right-click opens the
          shared menu while left-click and drag stay untouched. */}
      <ContextMenu.Trigger
        render={
          <button
            type="button"
            {...drag}
            onClick={() => onOpen(node.path)}
            onContextMenu={() => onMenuTarget(node.path)}
            onDragOver={(e) => dnd.onDragOver(parent, e)}
            onDrop={(e) => dnd.onDrop(parent, e)}
            style={indent}
            className={cn(
              "flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[13px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60",
              isActive && "bg-primary/15 font-medium text-primary",
              isDragging && "opacity-40",
            )}
          >
            <span className="ml-5 min-w-0 truncate">{node.name}</span>
            {status !== "clean" && (
              <span
                className={cn(
                  "ml-auto size-1.5 shrink-0 rounded-full",
                  status === "modified" ? "bg-modified" : "bg-added",
                )}
                title={
                  status === "modified" ? "Changed since last commit" : "New note, not committed"
                }
              />
            )}
          </button>
        }
      />
    </li>
  );
}

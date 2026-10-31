import type { ReactNode } from "react";
import {
  Calendar,
  ChevronsUpDown,
  FolderClosed,
  GitBranch,
  Moon,
  PanelLeftClose,
  RefreshCw,
  Search,
  SquarePen,
  Sun,
} from "lucide-react";
import type { SidePanel } from "@/lib/vault";
import { cn } from "@/lib/utils";

export interface SidebarProps {
  panel: SidePanel;
  vaultName: string;
  isRepo: boolean;
  hasRemote: boolean;
  onOpenFolder: () => void;
  changeCount: number;
  sync: "idle" | "pulling" | "pushing" | "syncing";
  lastSynced: string;
  dark: boolean;
  onToggleTheme: () => void;
  onPanel: (panel: SidePanel) => void;
  onCollapse: () => void;
  onDailyNote: () => void;
  onNewNote: () => void;
  onSync: () => void;
  children?: ReactNode;
  className?: string;
}

const tabs: { id: SidePanel; label: string; icon: typeof Search }[] = [
  { id: "files", label: "Files", icon: FolderClosed },
  { id: "search", label: "Search", icon: Search },
  { id: "git", label: "Sync", icon: GitBranch },
];

export function Sidebar({
  panel,
  vaultName,
  isRepo,
  hasRemote,
  onOpenFolder,
  changeCount,
  sync,
  lastSynced,
  dark,
  onToggleTheme,
  onPanel,
  onCollapse,
  onDailyNote,
  onNewNote,
  onSync,
  children,
  className,
}: SidebarProps) {
  const busy = sync !== "idle";

  const footer = !isRepo
    ? { label: "Initialize git", action: () => onPanel("git") }
    : !hasRemote
      ? {
          label: changeCount > 0 ? `${changeCount} uncommitted` : "Local only, no remote",
          action: () => onPanel("git"),
        }
      : {
          label:
            sync === "pulling"
              ? "Pulling…"
              : sync === "pushing"
                ? "Pushing…"
                : changeCount > 0
                  ? `${changeCount} to sync`
                  : `Synced ${lastSynced}`,
          action: onSync,
        };

  return (
    <aside
      aria-label="Vault"
      className={cn("flex w-64 shrink-0 flex-col border-r border-border bg-sidebar", className)}
    >
      <div
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center justify-between pr-2 pl-2 select-none"
      >
        <button
          type="button"
          onClick={onOpenFolder}
          title="Open another folder"
          className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-medium text-sidebar-foreground hover:bg-accent"
        >
          <FolderClosed className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{vaultName}</span>
          <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        </button>
        <div className="flex items-center">
          <IconButton label="Open today's note" onClick={onDailyNote}>
            <Calendar className="size-4" aria-hidden />
          </IconButton>
          <IconButton
            label={dark ? "Switch to light mode" : "Switch to dark mode"}
            onClick={onToggleTheme}
          >
            {dark ? (
              <Sun className="size-4" aria-hidden />
            ) : (
              <Moon className="size-4" aria-hidden />
            )}
          </IconButton>
          <IconButton label="Hide sidebar" onClick={onCollapse}>
            <PanelLeftClose className="size-4" aria-hidden />
          </IconButton>
        </div>
      </div>

      <button
        type="button"
        onClick={onNewNote}
        className="mx-3 mb-2 flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-[13px] text-sidebar-foreground transition-colors hover:bg-accent"
      >
        <SquarePen className="size-4 text-primary" aria-hidden />
        New note
        <kbd className="ml-auto font-mono text-[11px] text-muted-foreground">Ctrl N</kbd>
      </button>

      <div
        role="tablist"
        aria-label="Sidebar view"
        className="mx-3 mb-2 flex shrink-0 items-center gap-0.5 rounded-md bg-background/60 p-0.5"
      >
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={panel === id}
            onClick={() => onPanel(id)}
            className={cn(
              "relative flex h-7 flex-1 items-center justify-center gap-1.5 rounded text-xs text-muted-foreground transition-colors hover:text-foreground",
              panel === id && "bg-accent text-foreground",
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {label}
            {id === "git" && changeCount > 0 && (
              <span
                className="size-1.5 rounded-full bg-modified"
                aria-label={`${changeCount} changes`}
              />
            )}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1">{children}</div>

      <button
        type="button"
        onClick={footer.action}
        disabled={busy}
        className="mx-3 mb-3 flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:hover:bg-transparent"
      >
        {isRepo ? (
          <RefreshCw
            className={cn("size-3.5 shrink-0", busy && "animate-spin text-primary")}
            aria-hidden
          />
        ) : (
          <GitBranch className="size-3.5 shrink-0 text-primary" aria-hidden />
        )}
        <span className="truncate" aria-live="polite">
          {footer.label}
        </span>
        {isRepo && <span className="ml-auto font-mono text-[11px]">main</span>}
      </button>
    </aside>
  );
}

export function IconButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick?: () => void;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      className={cn(
        "flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:size-7",
        pressed && "text-foreground",
      )}
    >
      {children}
    </button>
  );
}

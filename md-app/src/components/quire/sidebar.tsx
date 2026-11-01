import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
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

const WIDTH_KEY = "md.sidebar-width";
const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 256;
const KEY_STEP = 16;
/* Floor for the editor pane: the sidebar may never eat the window. */
const MIN_MAIN = 320;

/* The usable ceiling depends on the window: a sidebar persisted on a large
   screen must not overflow a smaller one. Below the default width the floor
   wins — shrinking the window never pins the sidebar to its minimum, and the
   256px floor itself can't overflow any realistic desktop window. */
const maxForWindow = () =>
  Math.max(DEFAULT_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - MIN_MAIN));

const clampWidth = (w: number) => Math.min(maxForWindow(), Math.max(MIN_WIDTH, Math.round(w)));

const storedWidth = () => {
  const raw = localStorage.getItem(WIDTH_KEY);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? clampWidth(n) : DEFAULT_WIDTH;
};

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
  /** Enable the drag-to-resize edge. Off for the mobile drawer. */
  resizable?: boolean;
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
  resizable = true,
  children,
  className,
}: SidebarProps) {
  const busy = sync !== "idle";
  const [width, setWidth] = useState(storedWidth);
  const asideRef = useRef<HTMLElement>(null);
  // Drag session + the latest width it produced. Refs are for event-time
  // only — render reads state, which trails the pointer by at most one frame.
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const latest = useRef(width);
  const frame = useRef<number | null>(null);

  /* During a drag each pointer move writes the width straight to the DOM for
     zero-latency feedback; state catches up on the next animation frame, so
     re-renders stay at most one per frame and never lag the pointer visibly. */
  const scheduleSync = () => {
    if (frame.current != null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setWidth(latest.current);
    });
  };

  const cancelSync = () => {
    if (frame.current != null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
  };

  const commit = (next: number) => {
    cancelSync();
    const w = clampWidth(next);
    latest.current = w;
    setWidth(w);
    localStorage.setItem(WIDTH_KEY, String(w));
  };

  useEffect(() => () => cancelSync(), []);

  /* Shrinking the window (or restoring a width saved on a bigger one) can
     leave the sidebar wider than the pane — re-clamp whenever the window
     changes so the layout can never overflow horizontally. */
  useEffect(() => {
    if (!resizable) return;
    const reclamp = () => {
      setWidth((w) => {
        const next = clampWidth(w);
        if (next !== w) localStorage.setItem(WIDTH_KEY, String(next));
        return next;
      });
    };
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [resizable]);

  const endDrag = () => {
    const session = drag.current;
    drag.current = null;
    document.documentElement.classList.remove("resizing-sidebar");
    if (session) commit(latest.current);
  };

  const onResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // primary pointer only
    e.preventDefault();
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: latest.current };
    // Capture keeps the move/up stream on the handle even when the pointer
    // leaves the window — no dropped drags, no listeners on window. Can throw
    // for pointers the browser doesn't consider active (synthetic events,
    // captured-pointer edge cases); without it we still track moves that
    // bubble through the handle itself.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* drag proceeds without capture */
    }
    document.documentElement.classList.add("resizing-sidebar");
  };

  const onResizePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const session = drag.current;
    if (!session || session.pointerId !== e.pointerId) return;
    // Always measure from the drag origin so rapid moves never compound.
    const w = clampWidth(session.startWidth + e.clientX - session.startX);
    latest.current = w;
    if (asideRef.current) asideRef.current.style.width = `${w}px`;
    scheduleSync();
  };

  const onResizeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP * 3 : KEY_STEP;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      commit(latest.current - step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      commit(latest.current + step);
    } else if (e.key === "Home") {
      e.preventDefault();
      commit(DEFAULT_WIDTH);
    }
  };

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
      ref={asideRef}
      aria-label="Vault"
      style={resizable ? { width: `${width}px` } : undefined}
      className={cn(
        "relative flex w-64 shrink-0 flex-col border-r border-border bg-sidebar",
        className,
      )}
    >
      {resizable && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={maxForWindow()}
          aria-valuenow={width}
          title="Drag to resize · double-click to reset"
          tabIndex={0}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onDoubleClick={() => commit(DEFAULT_WIDTH)}
          onKeyDown={onResizeKeyDown}
          className={cn(
            "absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none rounded-full transition-colors select-none",
            "hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none active:bg-primary/50",
          )}
        />
      )}
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
          <span className="min-w-0 truncate">{vaultName}</span>
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
        <span className="min-w-0 truncate" aria-live="polite">
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

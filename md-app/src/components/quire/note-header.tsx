import {
  BookOpen,
  FileDiff,
  ListTree,
  PanelLeftOpen,
  PenLine,
  Search,
  SquarePen,
  Type,
} from "lucide-react";
import type { ViewMode } from "@/lib/vault";
import { IconButton } from "./sidebar";

type Props = {
  path: string | null;
  mode: ViewMode;
  /** Whether the diff viewer (not the editor) is showing the open note. */
  diffOpen: boolean;
  sidebarOpen: boolean;
  outlineOpen: boolean;
  onShowSidebar: () => void;
  onToggleMode: () => void;
  onToggleDiff: () => void;
  onToggleOutline: () => void;
  onOpenPalette: () => void;
  onOpenTypography: () => void;
  onNewNote: () => void;
};

export function NoteHeader({
  path,
  mode,
  diffOpen,
  sidebarOpen,
  outlineOpen,
  onShowSidebar,
  onToggleMode,
  onToggleDiff,
  onToggleOutline,
  onOpenPalette,
  onOpenTypography,
  onNewNote,
}: Props) {
  const parts = path ? path.replace(/\.md$/, "").split("/") : [];
  const title = parts.pop();

  return (
    <header
      data-tauri-drag-region
      className="flex h-11 shrink-0 items-center gap-2 px-2 select-none"
    >
      <span className={sidebarOpen ? "contents md:hidden" : "contents"}>
        <IconButton label="Show sidebar" onClick={onShowSidebar}>
          <PanelLeftOpen className="size-4" aria-hidden />
        </IconButton>
      </span>

      <p className="min-w-0 flex-1 truncate px-2 text-center text-[13px]" data-tauri-drag-region>
        {parts.length > 0 && <span className="text-muted-foreground">{parts.join(" / ")} / </span>}
        <span className="text-foreground">{title}</span>
      </p>

      <div className="flex items-center">
        <IconButton label="New note (Ctrl N)" onClick={onNewNote}>
          <SquarePen className="size-4" aria-hidden />
        </IconButton>
        <IconButton label="Search notes (Ctrl K)" onClick={onOpenPalette}>
          <Search className="size-4" aria-hidden />
        </IconButton>
        <IconButton label="Typography settings" onClick={onOpenTypography}>
          <Type className="size-4" aria-hidden />
        </IconButton>
        {path && (
          <>
            <IconButton
              label={mode === "edit" ? "Preview (Ctrl E)" : "Back to editing (Ctrl E)"}
              pressed={mode === "preview"}
              onClick={onToggleMode}
            >
              {mode === "edit" ? (
                <BookOpen className="size-4" aria-hidden />
              ) : (
                <PenLine className="size-4" aria-hidden />
              )}
            </IconButton>
            <IconButton
              label={diffOpen ? "Back to note (Ctrl Shift D)" : "View changes (Ctrl Shift D)"}
              pressed={diffOpen}
              onClick={onToggleDiff}
            >
              {diffOpen ? (
                <PenLine className="size-4" aria-hidden />
              ) : (
                <FileDiff className="size-4" aria-hidden />
              )}
            </IconButton>
            <span className="hidden lg:contents">
              <IconButton
                label="Outline and backlinks"
                pressed={outlineOpen}
                onClick={onToggleOutline}
              >
                <ListTree className="size-4" aria-hidden />
              </IconButton>
            </span>
          </>
        )}
      </div>
    </header>
  );
}

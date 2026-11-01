import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { FilePlus, FolderOpen } from "lucide-react";
import type { Vault } from "@/hooks/useVault";
import { useSidebarAutoCollapse } from "@/hooks/useSidebarAutoCollapse";
import { type SidePanel, type ViewMode, fileName, relTime, wordCount } from "@/lib/vault";
import { CommandPalette, type PaletteCommand } from "./command-palette";
import { DiffViewer } from "./diff-viewer";
import { FileTree } from "./file-tree";
import { GitPanel } from "./git-panel";
import { Inspector } from "./inspector";
import { MarkdownEditor, type EditorHandle } from "./note-editor";
import { MarkdownPreview } from "./note-preview";
import { NoteHeader } from "./note-header";
import { SearchPanel } from "./search-panel";
import { Sidebar, type SidebarProps } from "./sidebar";
import Modal from "../ui/Modal";

const noop = () => {};

const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

type Props = {
  vault: Vault;
  dark: boolean;
  onToggleTheme: () => void;
  onOpenFolder: () => void;
  onOpenSettings: () => void;
  onOpenTypography: () => void;
};

export function Workspace({
  vault,
  dark,
  onToggleTheme,
  onOpenFolder,
  onOpenSettings,
  onOpenTypography,
}: Props) {
  const {
    files,
    active,
    activeFile,
    open,
    setContent,
    writeNote,
    createNote,
    createFolder,
    deleteNote,
    revealNote,
    moveNote,
    syncNow,
    gitAction,
    status,
    gitState,
    changes,
    sync,
  } = vault;

  const [panel, setPanel] = useState<SidePanel>("files");
  // Note queued for deletion from the file-tree context menu; non-null opens
  // the confirmation modal.
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  // Note whose uncommitted changes are shown in the main area (from the
  // source-control panel); non-null replaces the editor with the diff viewer.
  const [diffPath, setDiffPath] = useState<string | null>(null);
  // Auto-collapses below 900px so a wide sidebar can never squeeze the
  // editor; manual toggles record the preference that gets restored.
  const {
    open: sidebarOpen,
    setOpen: setSidebar,
    toggle: toggleSidebar,
  } = useSidebarAutoCollapse();
  const [mode, setMode] = useState<ViewMode>("edit");
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const editorRef = useRef<EditorHandle>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ path: string; content: string } | null>(null);

  const flush = () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (stateTimer.current) {
      clearTimeout(stateTimer.current);
      stateTimer.current = null;
    }
    const p = pending.current;
    pending.current = null;
    if (p) {
      // Land the latest content in React state before saving/switching so the
      // UI never shows stale text for a note we just left.
      setContent(p.path, p.content);
      void writeNote(p.path, p.content);
    }
  };

  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Typing updates CodeMirror instantly (the editor owns its content); React
  // state — file tree statuses, outline, word count — catches up on a short
  // debounce so keystrokes don't re-render the whole workspace.
  const onChange = (content: string) => {
    if (!activeFile) return;
    const { path } = activeFile;
    pending.current = { path, content };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 700);
    if (stateTimer.current) clearTimeout(stateTimer.current);
    stateTimer.current = setTimeout(() => setContent(path, content), 250);
  };

  const titles = useMemo(() => new Map(files.map((f) => [fileName(f.path), f.path])), [files]);
  const paths = useMemo(() => new Set(files.map((f) => f.path)), [files]);
  const diffFile = useMemo(
    () => (diffPath ? (files.find((f) => f.path === diffPath) ?? null) : null),
    [diffPath, files],
  );
  const openNote = (path: string) => {
    flush();
    open(path);
    setDrawerOpen(false);
  };
  const showDiff = (path: string) => {
    flush();
    setDiffPath(path);
    setDrawerOpen(false);
  };
  const openFromDiff = (path: string) => {
    setDiffPath(null);
    openNote(path);
  };
  // Diff the note currently open in the editor (toolbar button / palette).
  const toggleDiff = () => {
    if (!activeFile) return;
    flush();
    setDiffPath((prev) => (prev === activeFile.path ? null : activeFile.path));
  };
  // The global keydown handler registers once, so it reads the latest
  // toggleDiff through a ref (same pattern as refreshRef in useVault).
  const toggleDiffRef = useRef(toggleDiff);
  useEffect(() => {
    toggleDiffRef.current = toggleDiff;
  });
  const isMobile = () => !window.matchMedia("(min-width: 768px)").matches;
  const showSidebar = () => (isMobile() ? setDrawerOpen(true) : setSidebar(true));
  const toggleMode = () => setMode((m) => (m === "edit" ? "preview" : "edit"));
  const showPanel = (next: SidePanel) => {
    setPanel(next);
    showSidebar();
  };

  // Link targets come in several dialects: wikilinks ("Note",
  // "Areas/Dev/Note", "Note|alias", "Note#heading") and markdown paths
  // ("notes/foo.md", "./foo", "foo"). Resolve to an existing note path,
  // relative to `from` when given — Obsidian-style shortest-unique match.
  const resolveLinkTarget = (raw: string, from?: string | null): string | null => {
    let target = raw;
    try {
      target = decodeURIComponent(raw);
    } catch {
      /* keep the raw string */
    }
    target = target.split("|")[0].split("#")[0].trim();
    if (!target) return null;
    const withExt = target.endsWith(".md") ? target : `${target}.md`;
    const candidates = [target, withExt];
    if (from) {
      const base = from.split("/").slice(0, -1).join("/");
      const prefix = base ? `${base}/` : "";
      candidates.push(prefix + target, prefix + withExt);
    }
    for (const candidate of candidates) if (paths.has(candidate)) return candidate;
    const suffixHits = files.filter((f) =>
      candidates.some((c) => f.path === c || f.path.endsWith(`/${c}`)),
    );
    if (suffixHits.length === 1) return suffixHits[0].path;
    return titles.get(target.replace(/\.md$/, "")) ?? null;
  };

  const openByTitle = (title: string) => {
    const name = title.split("|")[0].split("#")[0].trim();
    const path = resolveLinkTarget(title, activeFile?.path ?? null);
    if (path) openNote(path);
    else void createNote(name);
  };

  const newNote = () => {
    flush();
    void createNote();
    setMode("edit");
    setDrawerOpen(false);
  };

  // Toggle the task checkbox on a 0-based source line (from the preview).
  const toggleTaskLine = (line: number) => {
    if (!activeFile) return;
    // Read the freshest buffer — React state may lag behind the editor.
    const latest =
      pending.current?.path === activeFile.path ? pending.current.content : activeFile.content;
    const lines = latest.split("\n");
    if (line < 0 || line >= lines.length) return;
    lines[line] = lines[line].replace(/\[[ xX]\]/, (m) => (m === "[ ]" ? "[x]" : "[ ]"));
    onChange(lines.join("\n"));
  };

  const newFolder = () => {
    const taken = new Set(files.map((f) => f.path.split("/").slice(0, -1).join("/")));
    let name = "New folder";
    for (let n = 2; taken.has(name); n++) name = `New folder ${n}`;
    void createFolder(name);
    setPanel("files");
  };

  const confirmDelete = () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (target) void deleteNote(target);
  };

  const dailyNote = () => {
    flush();
    const path = `Journal/${today()}.md`;
    if (titles.has(path.replace(/\.md$/, "").split("/").pop()!)) openNote(path);
    else void createNote(path);
    setDrawerOpen(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawerOpen(false);
        setDiffPath(null);
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "k" || key === "o") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (key === "n" && !e.shiftKey) {
        e.preventDefault();
        newNote();
      } else if (key === "e") {
        e.preventDefault();
        setMode((m) => (m === "edit" ? "preview" : "edit"));
      } else if (e.shiftKey && key === "f") {
        e.preventDefault();
        showPanel("search");
      } else if (e.shiftKey && key === "g") {
        e.preventDefault();
        showPanel("git");
      } else if (e.shiftKey && key === "d") {
        e.preventDefault();
        toggleDiffRef.current();
      } else if (key === "\\") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => {
      if (mq.matches) setDrawerOpen(false);
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const commands: PaletteCommand[] = [
    { id: "new", label: "New note", hint: "Ctrl N", run: newNote },
    { id: "daily", label: "Open today's note", run: dailyNote },
    { id: "folder", label: "New folder", run: newFolder },
    { id: "open", label: "Open folder as vault…", run: onOpenFolder },
    { id: "settings", label: "Vault settings", run: onOpenSettings },
    { id: "typography", label: "Typography settings", run: onOpenTypography },
    { id: "mode", label: "Toggle preview", hint: "Ctrl E", run: toggleMode },
    {
      id: "diff",
      label: "Show diff for current note",
      hint: "Ctrl Shift D",
      run: toggleDiff,
    },
    {
      id: "search",
      label: "Search in all notes",
      hint: "Ctrl Shift F",
      run: () => showPanel("search"),
    },
    { id: "sync", label: "Sync now", run: () => void syncNow() },
    { id: "pull", label: "Git: Pull (take remote)", run: () => void gitAction("take-remote") },
    { id: "push", label: "Git: Push", run: () => void gitAction("push") },
    { id: "scm", label: "Show sync panel", hint: "Ctrl Shift G", run: () => showPanel("git") },
  ];

  const editorProps = activeFile
    ? {
        ref: editorRef,
        file: activeFile,
        dir: vault.dir,
        onChange,
        onCursor: noop,
        onOpenLink: openByTitle,
      }
    : null;

  const hasRemote = !!(gitState?.remoteUrl ?? status?.remoteMain);
  const sidebarProps: SidebarProps = {
    panel,
    vaultName: vault.name,
    isRepo: true,
    hasRemote,
    onOpenFolder,
    changeCount: changes.length,
    sync,
    lastSynced: status?.lastRun
      ? relTime(status.lastRun.finishedAt ?? status.lastRun.startedAt)
      : "never",
    dark,
    onToggleTheme,
    onPanel: setPanel,
    onCollapse: () => (isMobile() ? setDrawerOpen(false) : setSidebar(false)),
    onDailyNote: dailyNote,
    onNewNote: newNote,
    onSync: () => void syncNow(),
  };

  const sidebarContent = (
    <>
      {panel === "files" && (
        <FileTree
          files={files}
          folders={[]}
          showStatus
          active={active}
          onOpen={openNote}
          onCreate={newNote}
          onCreateFolder={newFolder}
          onOpenFolder={onOpenFolder}
          onMove={(from, toFolder) => void moveNote(from, toFolder)}
          onDelete={setDeleteTarget}
          onReveal={(path) => void revealNote(path)}
        />
      )}
      {panel === "search" && <SearchPanel onOpen={openNote} search={vault.search} />}
      {panel === "git" && (
        <GitPanel
          name={vault.name}
          isRepo
          hasRemote={hasRemote}
          relation={gitState?.relation ?? "unknown"}
          head={gitState?.head ?? status?.head ?? null}
          remoteHead={gitState?.remote ?? status?.remoteMain ?? null}
          changes={changes}
          sync={sync}
          lastRun={status?.lastRun ?? null}
          lastSyncError={vault.lastSyncError}
          onOpen={openNote}
          onShowDiff={showDiff}
          diffPath={diffPath}
          onSync={() => void syncNow()}
          onGitAction={(a) => void gitAction(a)}
          onInit={() => void syncNow()}
        />
      )}
    </>
  );

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden">
      {sidebarOpen && (
        <div className="hidden md:contents">
          <Sidebar {...sidebarProps} onCollapse={() => setSidebar(false)}>
            {sidebarContent}
          </Sidebar>
        </div>
      )}

      {drawerOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <button
            type="button"
            aria-label="Close sidebar"
            className="absolute inset-0 bg-background/70 backdrop-blur-[2px]"
            onClick={() => setDrawerOpen(false)}
          />
          <Sidebar
            {...sidebarProps}
            onCollapse={() => setDrawerOpen(false)}
            resizable={false}
            className="relative w-[85%] max-w-xs pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-2xl"
          >
            {sidebarContent}
          </Sidebar>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <NoteHeader
          path={activeFile?.path ?? null}
          mode={mode}
          diffOpen={!!activeFile && diffPath === activeFile.path}
          sidebarOpen={sidebarOpen}
          outlineOpen={outlineOpen}
          onShowSidebar={showSidebar}
          onToggleMode={toggleMode}
          onToggleDiff={toggleDiff}
          onToggleOutline={() => setOutlineOpen((o) => !o)}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenTypography={onOpenTypography}
          onNewNote={newNote}
        />

        {diffFile ? (
          <DiffViewer
            key={diffFile.path}
            file={diffFile}
            onOpenNote={openFromDiff}
            onClose={() => setDiffPath(null)}
          />
        ) : activeFile && editorProps ? (
          <div className="flex min-h-0 flex-1">
            <section aria-label="Editor" className="relative min-w-0 flex-1">
              {mode === "edit" ? (
                <MarkdownEditor key={activeFile.path} {...editorProps} dark={dark} />
              ) : (
                <MarkdownPreview
                  key={activeFile.path}
                  file={activeFile}
                  dir={vault.dir}
                  onOpenLink={openByTitle}
                  onToggleTask={toggleTaskLine}
                />
              )}
              <div
                className="pointer-events-none absolute right-6 bottom-3 z-10 rounded-md border border-border bg-panel/90 px-2.5 py-1 text-[11px] text-muted-foreground backdrop-blur-sm"
                aria-label="Note statistics"
              >
                {wordCount(activeFile.content)} words · {activeFile.content.length} chars
              </div>
            </section>
            {outlineOpen && (
              <Inspector
                file={activeFile}
                files={files}
                onOpen={openNote}
                onJump={(line) => editorRef.current?.jumpTo(line)}
              />
            )}
          </div>
        ) : (
          <EmptyState onCreate={newNote} onOpenFolder={onOpenFolder} />
        )}
      </main>

      {paletteOpen && (
        <CommandPalette
          files={files}
          commands={commands}
          onOpenFile={openNote}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      <Modal
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        className="top-1/3 w-80 max-w-[90vw]"
      >
        <Dialog.Title className="mb-1 text-sm font-semibold">Delete note</Dialog.Title>
        <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
          “{deleteTarget ? fileName(deleteTarget) : ""}” will be removed from your vault. Notes
          already committed can still be recovered from git history.
        </p>
        <div className="flex justify-end gap-2">
          <Dialog.Close className="rounded-md px-2.5 py-1 text-xs hover:bg-accent">
            Cancel
          </Dialog.Close>
          <button
            type="button"
            onClick={confirmDelete}
            className="rounded-md bg-destructive px-2.5 py-1 text-xs text-destructive-foreground hover:opacity-90"
          >
            Delete
          </button>
        </div>
      </Modal>
    </div>
  );
}

function EmptyState({
  onCreate,
  onOpenFolder,
}: {
  onCreate: () => void;
  onOpenFolder: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
        No note open. Every note is a plain markdown file in your vault.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={onCreate}
          className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:opacity-90"
        >
          <FilePlus className="size-3.5" aria-hidden />
          New note
        </button>
        <button
          type="button"
          onClick={onOpenFolder}
          className="flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[13px] text-foreground hover:bg-accent"
        >
          <FolderOpen className="size-3.5" aria-hidden />
          Open folder
        </button>
      </div>
    </div>
  );
}

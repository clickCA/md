import { useEffect, useRef, useState } from "react";
import { FilePlus, FolderOpen } from "lucide-react";
import type { Vault } from "@/hooks/useVault";
import type { EditorHandle } from "@/lib/blocks";
import { type SidePanel, type ViewMode, fileName, relTime } from "@/lib/vault";
import { CommandPalette, type PaletteCommand } from "./command-palette";
import { FileTree } from "./file-tree";
import { GitPanel } from "./git-panel";
import { Inspector } from "./inspector";
import { LiveEditor } from "./live-editor";
import { NoteHeader } from "./note-header";
import { SourceEditor } from "./note-editor";
import { SearchPanel } from "./search-panel";
import { Sidebar, type SidebarProps } from "./sidebar";

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
};

export function Workspace({ vault, dark, onToggleTheme, onOpenFolder, onOpenSettings }: Props) {
  const {
    files,
    active,
    activeFile,
    open,
    setContent,
    writeNote,
    createNote,
    createFolder,
    moveNote,
    syncNow,
    gitAction,
    status,
    gitState,
    changes,
    sync,
  } = vault;

  const [panel, setPanel] = useState<SidePanel>("files");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mode, setMode] = useState<ViewMode>("live");
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const editorRef = useRef<EditorHandle>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ path: string; content: string } | null>(null);

  const flush = () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const p = pending.current;
    pending.current = null;
    if (p) void writeNote(p.path, p.content);
  };

  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const onChange = (content: string) => {
    if (!activeFile) return;
    setContent(activeFile.path, content);
    pending.current = { path: activeFile.path, content };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 700);
  };

  const titles = new Map(files.map((f) => [fileName(f.path), f.path]));
  const openNote = (path: string) => {
    flush();
    open(path);
    setDrawerOpen(false);
  };
  const isMobile = () => !window.matchMedia("(min-width: 768px)").matches;
  const showSidebar = () => (isMobile() ? setDrawerOpen(true) : setSidebarOpen(true));
  const toggleMode = () => setMode((m) => (m === "live" ? "source" : "live"));
  const showPanel = (next: SidePanel) => {
    setPanel(next);
    showSidebar();
  };

  const openByTitle = (title: string) => {
    const path = titles.get(title);
    if (path) openNote(path);
    else void createNote(title);
  };

  const newNote = () => {
    flush();
    void createNote();
    setMode("live");
    setDrawerOpen(false);
  };

  const newFolder = () => {
    const taken = new Set(files.map((f) => f.path.split("/").slice(0, -1).join("/")));
    let name = "New folder";
    for (let n = 2; taken.has(name); n++) name = `New folder ${n}`;
    void createFolder(name);
    setPanel("files");
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
      if (e.key === "Escape") setDrawerOpen(false);
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
        setMode((m) => (m === "live" ? "source" : "live"));
      } else if (e.shiftKey && key === "f") {
        e.preventDefault();
        showPanel("search");
      } else if (e.shiftKey && key === "g") {
        e.preventDefault();
        showPanel("git");
      } else if (key === "\\") {
        e.preventDefault();
        setSidebarOpen((o) => !o);
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
    { id: "mode", label: "Toggle markdown source", hint: "Ctrl E", run: toggleMode },
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
        onChange,
        onCursor: noop,
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
    onCollapse: () => (isMobile() ? setDrawerOpen(false) : setSidebarOpen(false)),
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
          onSync={() => void syncNow()}
          onGitAction={(a) => void gitAction(a)}
          onInit={() => void syncNow()}
        />
      )}
    </>
  );

  return (
    <div className="flex h-full min-w-0 flex-1">
      {sidebarOpen && (
        <div className="hidden md:contents">
          <Sidebar {...sidebarProps} onCollapse={() => setSidebarOpen(false)}>
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
          sidebarOpen={sidebarOpen}
          outlineOpen={outlineOpen}
          onShowSidebar={showSidebar}
          onToggleMode={toggleMode}
          onToggleOutline={() => setOutlineOpen((o) => !o)}
          onOpenPalette={() => setPaletteOpen(true)}
          onNewNote={newNote}
        />

        {activeFile && editorProps ? (
          <div className="flex min-h-0 flex-1">
            <section aria-label="Editor" className="min-w-0 flex-1">
              {mode === "live" ? (
                <LiveEditor
                  key={activeFile.path}
                  {...editorProps}
                  dir={vault.dir}
                  dark={dark}
                  onOpenLink={openByTitle}
                  existing={new Set(titles.keys())}
                />
              ) : (
                <SourceEditor key={activeFile.path} {...editorProps} />
              )}
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

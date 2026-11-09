import { useEffect, useMemo, useRef, useState } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { FilePlus, FolderOpen } from "lucide-react";
import type { Vault } from "@/hooks/useVault";
import type { HistoryEntry } from "@/types";
import { useBackClose } from "@/hooks/useBackClose";
import { useSidebarAutoCollapse } from "@/hooks/useSidebarAutoCollapse";
import { useAgent } from "@/hooks/useAgent";
import { useAiNote } from "@/hooks/useAiNote";
import { useAiAsk } from "@/hooks/useAiAsk";
import { useFolderSummary } from "@/hooks/useFolderSummary";
import { type SidePanel, type ViewMode, fileName, parentOf, relTime, wordCount } from "@/lib/vault";
import type { BrokenLink } from "@/types";
import { AgentPanel } from "./AgentPanel";
import { AiNoteModal } from "./AiNoteModal";
import { AiAskModal } from "./AiAskModal";
import { FolderSummaryModal } from "./FolderSummaryModal";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";
import { DiffViewer } from "./DiffViewer";
import { FileTree } from "./FileTree";
import { GitPanel } from "./GitPanel";
import { Inspector } from "./Inspector";
import { LinksPanel } from "./LinksPanel";
import { MarkdownEditor, type EditorHandle } from "./NoteEditor";
import { MarkdownPreview } from "./NotePreview";
import { NoteHeader } from "./NoteHeader";
import { RevisionViewer } from "./RevisionViewer";
import { SearchPanel } from "./SearchPanel";
import { Sidebar, type SidebarProps } from "./Sidebar";
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
  onCheckUpdates: () => void;
  onToggleTheme: () => void;
  onOpenFolder: () => void;
  onOpenSettings: () => void;
  onOpenTypography: () => void;
};

export function Workspace({
  vault,
  dark,
  onCheckUpdates,
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
  // Broken-link report, scanned lazily when the Links panel opens.
  const [linksReport, setLinksReport] = useState<BrokenLink[] | null>(null);
  const [linksLoading, setLinksLoading] = useState(false);
  /** Cross-note jump: open then scroll to this line once the editor mounts. */
  const pendingJump = useRef<{ path: string; line: number } | null>(null);
  // Note queued for deletion from the file-tree context menu; non-null opens
  // the confirmation modal.
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  // Note whose uncommitted changes are shown in the main area (from the
  // source-control panel); non-null replaces the editor with the diff viewer.
  const [diffPath, setDiffPath] = useState<string | null>(null);
  // Revision opened read-only from the source-control history section;
  // non-null replaces the editor with the revision viewer.
  const [revision, setRevision] = useState<{ entry: HistoryEntry; content: string } | null>(null);
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
  const [aiNoteOpen, setAiNoteOpen] = useState(false);
  const [aiAskOpen, setAiAskOpen] = useState(false);
  // Folder targeted by "Summarize with AI"; non-null opens the preview modal.
  const [summaryFolder, setSummaryFolder] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const editorRef = useRef<EditorHandle>(null);

  // System back gesture (Android) closes the topmost overlay instead of
  // leaving the app — each open overlay holds one webview-history entry.
  useBackClose(drawerOpen, () => setDrawerOpen(false));
  useBackClose(paletteOpen, () => setPaletteOpen(false));
  useBackClose(diffPath !== null, () => setDiffPath(null));
  useBackClose(revision !== null, () => setRevision(null));
  useBackClose(deleteTarget !== null, () => setDeleteTarget(null));

  // AI agent panel: runs a coding-agent CLI against the vault directory and
  // streams its output. Agent edits land in the working tree — refresh the
  // vault so the file tree / source control pick them up right away.
  const agent = useAgent(vault.dir, (changed) => {
    if (changed.length > 0) void vault.refresh();
  });
  const agentState = {
    providers: agent.providers,
    selected: agent.selected,
    onSelect: agent.setSelected,
    running: agent.running,
    turns: agent.turns,
    error: agent.error,
    input: agent.input,
    onInput: agent.setInput,
    onSend: () => void agent.run(agent.input),
    onStop: () => void agent.stop(),
    onNewSession: agent.newSession,
    autoApprove: agent.autoApprove,
    onAutoApproveChange: agent.setAutoApprove,
    files: files,
    onOpenFile: (path: string) => openNote(path),
  };

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

  // Deferred cross-note jump: the target editor mounts in the same commit,
  // and child effects run first, so the view is ready when this fires.
  useEffect(() => {
    const j = pendingJump.current;
    if (j && activeFile?.path === j.path) {
      pendingJump.current = null;
      editorRef.current?.jumpTo(j.line);
    }
  }, [activeFile]);

  const titles = useMemo(() => new Map(files.map((f) => [fileName(f.path), f.path])), [files]);
  const paths = useMemo(() => new Set(files.map((f) => f.path)), [files]);
  const diffFile = useMemo(
    () => (diffPath ? (files.find((f) => f.path === diffPath) ?? null) : null),
    [diffPath, files],
  );
  // Ask-your-notes: retrieval Q&A over the vault (FTS5 excerpts + the
  // inline seam); answers cite their sources and open them on click.
  const aiAsk = useAiAsk({ dir: vault.dir });

  const openNote = (path: string) => {
    flush();
    setRevision(null);
    open(path);
    setDrawerOpen(false);
  };

  // Create-note-through-AI: the generated note lands via the normal write
  // path; open it and refresh so the tree shows it right away.
  const aiNote = useAiNote({
    dir: vault.dir,
    onCreated: (path) => {
      setAiNoteOpen(false);
      void vault.refresh();
      openNote(path);
    },
  });

  // Folder summary: aggregates the visible notes under one folder (the backend
  // already dropped .quireignore matches), previews the result, and writes the
  // note only on Accept — through the normal write path so git sees it.
  const folderSummary = useFolderSummary({
    dir: vault.dir,
    files,
    onWrite: async (path, content) => {
      await writeNote(path, content);
      await vault.refresh();
      setSummaryFolder(null);
      openNote(path);
    },
  });
  const summarizeFolder = (folder: string) => {
    setSummaryFolder(folder);
    void folderSummary.summarize(folder);
  };
  // Back while an AI modal is mid-run must not orphan the request: mirror the
  // modals' own close guards.
  useBackClose(aiNoteOpen, () => {
    if (aiNote.phase.kind !== "running") setAiNoteOpen(false);
  });
  useBackClose(aiAskOpen, () => {
    if (aiAsk.phase.kind !== "running") setAiAskOpen(false);
  });
  useBackClose(summaryFolder !== null, () => {
    if (folderSummary.phase.kind === "running") void folderSummary.stop();
    folderSummary.dismiss();
    setSummaryFolder(null);
  });
  const showDiff = (path: string) => {
    flush();
    setRevision(null);
    setDiffPath(path);
    setDrawerOpen(false);
  };
  /** Open a history revision read-only in the main area. */
  const showRevision = async (entry: HistoryEntry) => {
    flush();
    const content = await vault.noteRevision(entry);
    if (content !== null) {
      setDiffPath(null);
      setRevision({ entry, content });
      setDrawerOpen(false);
    }
  };
  /** Restore a revision (normal forward change), then close the viewer. */
  const restoreRevision = async (entry: HistoryEntry) => {
    await vault.restoreNote(entry);
    setRevision(null);
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
    if (next === "links") scanLinks();
    showSidebar();
  };

  const scanLinks = () => {
    if (linksLoading) return;
    setLinksLoading(true);
    void vault
      .brokenLinks()
      .then((r) => setLinksReport(r))
      .finally(() => setLinksLoading(false));
  };

  /** Open a note and jump to a line once its editor is mounted. */
  const openAt = (path: string, line: number) => {
    openNote(path);
    pendingJump.current = { path, line };
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
      } else if (e.shiftKey && key === "a") {
        e.preventDefault();
        setAgentOpen((o) => !o);
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

  // Drawer edge swipes (mobile only): drag in from the left screen edge opens
  // the drawer; a horizontal swipe left on the drawer closes it. Read-only
  // touch listeners — we never preventDefault, so scrolling and taps inside
  // the drawer (and under the edge zone) are untouched.
  const drawerSwipe = useRef<{ x: number; y: number } | null>(null);
  const onDrawerTouchStart = (e: ReactTouchEvent) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    // Swipes born on buttons/inputs are taps with jitter — let them be clicks.
    if ((t.target as HTMLElement).closest?.("button, a, input, textarea")) return;
    drawerSwipe.current = { x: t.clientX, y: t.clientY };
  };
  const onDrawerTouchEnd = (e: ReactTouchEvent) => {
    const start = drawerSwipe.current;
    drawerSwipe.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (dx < -56 && Math.abs(dx) > Math.abs(dy) * 1.5) setDrawerOpen(false);
  };

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    if (mq.matches) return; // desktop: no edge gesture
    let start: { x: number; y: number } | null = null;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (t.clientX > 28) return;
      if ((t.target as HTMLElement).closest?.("button, a, input, textarea")) return;
      start = { x: t.clientX, y: t.clientY };
    };
    const onEnd = (e: TouchEvent) => {
      if (!start) return;
      const s = start;
      start = null;
      const t = e.changedTouches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (dx > 56 && Math.abs(dx) > Math.abs(dy) * 1.5) setDrawerOpen(true);
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchend", onEnd);
    };
    // Re-arm per drawer state so a closing swipe never instantly reopens.
  }, [drawerOpen]); // eslint-disable-line react-hooks/exhaustive-deps

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
    {
      id: "agent",
      label: "Toggle AI agent panel",
      hint: "Ctrl Shift A",
      run: () => setAgentOpen((o) => !o),
    },
    {
      id: "ai-note",
      label: "AI: Create a note from a description",
      run: () => setAiNoteOpen(true),
    },
    {
      id: "ai-ask",
      label: "AI: Ask your notes",
      run: () => setAiAskOpen(true),
    },
    {
      id: "ai-summary",
      label: "AI: Summarize folder…",
      run: () => summarizeFolder(active ? parentOf(active) : ""),
    },
    { id: "sync", label: "Sync now", run: () => void syncNow() },
    { id: "update", label: "Check for updates", run: () => void onCheckUpdates() },
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
          onSummarizeFolder={summarizeFolder}
        />
      )}
      {panel === "search" && <SearchPanel onOpen={openNote} search={vault.search} />}
      {panel === "links" && (
        <LinksPanel
          report={linksReport}
          loading={linksLoading}
          onRescan={scanLinks}
          onOpenLink={openAt}
        />
      )}
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
          syncExcluded={status?.syncExcluded ?? false}
          onToggleSyncExcluded={(on) => void vault.setSyncExcluded(on)}
          lastRun={status?.lastRun ?? null}
          lastSyncError={vault.lastSyncError}
          activePath={active}
          branch={gitState?.branch ?? "main"}
          loadBranches={vault.loadBranches}
          onSwitchBranch={(name) => {
            // The open diff/revision refers to the previous branch's world.
            setDiffPath(null);
            setRevision(null);
            void vault.switchBranch(name);
          }}
          onCreateBranch={vault.createBranch}
          loadNoteHistory={vault.noteHistory}
          loadVaultHistory={vault.vaultHistory}
          onShowRevision={(entry) => void showRevision(entry)}
          onRestoreSnapshot={(oid) => void vault.restoreSnapshot(oid)}
          onOpen={(path) => {
            setRevision(null);
            openNote(path);
          }}
          onShowDiff={showDiff}
          diffPath={diffPath}
          onSync={() => void syncNow()}
          onGitAction={(a) => void gitAction(a)}
          loadRemotes={vault.loadRemotes}
          onRemoteAdd={vault.remoteAdd}
          onRemoteRemove={(name) => void vault.remoteRemove(name)}
          onRemoteRename={vault.remoteRename}
          onRemoteSetPrimary={(name) => void vault.remoteSetPrimary(name)}
          onSyncFrom={(name) => void vault.syncFrom(name)}
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
        <div
          className="fixed inset-0 z-40 flex md:hidden"
          onTouchStart={onDrawerTouchStart}
          onTouchEnd={onDrawerTouchEnd}
        >
          <button
            type="button"
            aria-label="Close sidebar"
            className="quire-fade-in absolute inset-0 bg-background/70 backdrop-blur-[2px]"
            onClick={() => setDrawerOpen(false)}
          />
          <Sidebar
            {...sidebarProps}
            onCollapse={() => setDrawerOpen(false)}
            resizable={false}
            className="quire-drawer-slide-in relative w-[85%] max-w-xs pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-2xl"
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
          agentOpen={agentOpen}
          onToggleAgent={() => setAgentOpen((o) => !o)}
        />

        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {diffFile ? (
              <DiffViewer
                key={diffFile.path}
                file={diffFile}
                onOpenNote={openFromDiff}
                onClose={() => setDiffPath(null)}
              />
            ) : revision ? (
              <RevisionViewer
                key={`${revision.entry.oid}-${revision.entry.path}`}
                entry={revision.entry}
                content={revision.content}
                onRestore={(entry) => void restoreRevision(entry)}
                onClose={() => setRevision(null)}
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
          </div>

          {agentOpen && <AgentPanel {...agentState} />}
        </div>
      </main>

      {aiNoteOpen && (
        <AiNoteModal
          phase={aiNote.phase}
          providerLabel={aiNote.provider}
          onCreate={(d) => void aiNote.create(d)}
          onStop={() => void aiNote.stop()}
          onDismiss={aiNote.dismiss}
          onClose={() => {
            if (aiNote.phase.kind !== "running") setAiNoteOpen(false);
          }}
        />
      )}

      {summaryFolder !== null && folderSummary.phase.kind !== "idle" && (
        <FolderSummaryModal
          phase={folderSummary.phase}
          providerLabel={folderSummary.provider}
          onAccept={(content) => void folderSummary.accept(content)}
          onStop={() => void folderSummary.stop()}
          onRegenerate={() => void folderSummary.summarize(summaryFolder)}
          onDismiss={() => {
            folderSummary.dismiss();
            setSummaryFolder(null);
          }}
          onClose={() => {
            if (folderSummary.phase.kind !== "running") {
              folderSummary.dismiss();
              setSummaryFolder(null);
            }
          }}
        />
      )}

      {aiAskOpen && (
        <AiAskModal
          phase={aiAsk.phase}
          providerLabel={aiAsk.provider}
          files={files}
          onAsk={(q) => void aiAsk.ask(q)}
          onStop={() => void aiAsk.stop()}
          onDismiss={aiAsk.dismiss}
          onClose={() => {
            if (aiAsk.phase.kind !== "running") setAiAskOpen(false);
          }}
          onOpenCitation={(path) => {
            setAiAskOpen(false);
            openNote(path);
          }}
        />
      )}

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

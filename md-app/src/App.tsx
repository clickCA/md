import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Dialog } from "@base-ui/react/dialog";
import {
  CloudUpload,
  FilePlus2,
  FolderOpen,
  Menu,
  Moon,
  Settings,
  Sun,
  X,
} from "lucide-react";
import LiveMarkdownEditor from "./components/LiveMarkdownEditor";
import ConflictCard from "./components/ConflictCard";
import FileTree from "./components/FileTree";
import SearchResults, { type SearchHit } from "./components/SearchResults";
import { Search } from "lucide-react";

interface Conflict {
  path: string;
  conflictCopy: string;
  winner: string;
  at: string;
}

interface Journal {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  events: [string, string][];
}

interface Status {
  root: string;
  head: string | null;
  remoteMain: string | null;
  pending: boolean;
  conflicts: Conflict[];
  lastRun: Journal | null;
}

interface SyncResult {
  action: string;
  head: string | null;
  remote: string | null;
  conflicts: Conflict[];
}

interface Probe {
  exists: boolean;
  isVault: boolean;
  remoteUrl: string | null;
  noteCount: number | null;
}

const DEFAULT_DIR = "/tmp/md-vault";

/** Platform-appropriate vault location (app-sandboxed on mobile). */
async function resolveDefaultDir(): Promise<string> {
  try {
    const d = await invoke<string>("default_vault_dir");
    if (d) return d;
  } catch {
    // fall back to the desktop demo default
  }
  return DEFAULT_DIR;
}

function short(oid: string | null): string {
  return oid ? oid.slice(0, 7) : "—";
}

function useVault(dir: string) {
  const [status, setStatus] = useState<Status | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await fn();
      } catch (e) {
        setError(`${label}: ${e}`);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const refresh = useCallback(
    async (d: string = dir) => {
      const [s, n] = await Promise.all([
        invoke<Status>("vault_status", { dir: d }),
        invoke<string[]>("note_list", { dir: d }),
      ]);
      setStatus(s);
      setNotes(n);
    },
    [dir],
  );

  return { status, notes, error, busy, run, refresh, setError };
}

function NotesList(props: {
  notes: string[];
  activeNote: string | null;
  onPick: (path: string) => void;
  onDelete: (path: string) => void;
  alwaysShowDelete?: boolean;
}) {
  return <FileTree {...props} />;
}

export default function App() {
  const [dir, setDir] = useState(DEFAULT_DIR);
  const [dark, setDark] = useState(
    window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  const { status, notes, error, busy, run, refresh } = useVault(dir);

  useEffect(() => {
    void resolveDefaultDir().then(setDir);
  }, []);

  const [notePath, setNotePath] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [dirty, setDirty] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  const [newNoteName, setNewNoteName] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [setupDir, setSetupDir] = useState<string | null>(null);
  const [setupRemote, setSetupRemote] = useState("");
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelAutosave = () => {
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
  };

  useEffect(() => cancelAutosave, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  // debounced vault-wide search
  useEffect(() => {
    const q = query.trim();
    if (!q || !status) {
      setSearchHits(null);
      return;
    }
    const t = setTimeout(() => {
      invoke<SearchHit[]>("search_notes", { dir, query: q })
        .then(setSearchHits)
        .catch(() => setSearchHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [query, dir, status]);

  /** Native folder picker → probe → open, or offer one-step vault setup. */
  const pickVault = async () => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Choose vault folder",
    });
    if (typeof picked !== "string" || !picked) return;
    const probe = await invoke<Probe>("vault_probe", { dir: picked });
    if (probe.isVault) {
      setDir(picked);
      await run("open", async () => {
        await refresh(picked);
      });
    } else {
      setDir(picked);
      setSetupRemote(probe.remoteUrl ?? "");
      setSetupDir(picked);
    }
  };

  const connectVault = (d: string, remote: string | null) =>
    run("connect", async () => {
      await invoke<Status>("vault_make", { dir: d, remoteUrl: remote });
      await refresh(d);
      setSetupDir(null);
    });

  const reloadOpenNote = useCallback(
    async (path: string) => {
      const content = await invoke<string>("note_read", { dir, path });
      setBody(content);
      setDirty(false);
    },
    [dir],
  );

  const doSync = () =>
    run("sync", async () => {
      cancelAutosave();
      const r = await invoke<SyncResult>("vault_sync", { dir });
      setSyncResult(r);
      await refresh();
      if (notePath) await reloadOpenNote(notePath);
    });

  const loadNote = (path: string) =>
    run("read", async () => {
      cancelAutosave();
      const content = await invoke<string>("note_read", { dir, path });
      setNotePath(path);
      setBody(content);
      setDirty(false);
      setMenuOpen(false);
    });

  const saveNote = useCallback(
    async (content: string) => {
      if (!notePath) return;
      cancelAutosave();
      await run("write", async () => {
        await invoke("note_write", { dir, path: notePath, content });
        await refresh();
      });
      setDirty(false);
    },
    [dir, notePath, run, refresh],
  );

  const onEditorChange = useCallback(
    (value: string) => {
      setBody(value);
      setDirty(true);
      cancelAutosave();
      autosaveTimer.current = setTimeout(() => void saveNote(value), 800);
    },
    [saveNote],
  );

  const deleteNote = (path: string) =>
    run("delete", async () => {
      cancelAutosave();
      await invoke("note_delete", { dir, path });
      if (notePath === path) {
        setNotePath(null);
        setBody("");
        setDirty(false);
      }
      await refresh();
    });

  const createNote = () =>
    run("create", async () => {
      const name = newNoteName.trim();
      if (!name) return;
      const path = name.endsWith(".md") ? name : `${name}.md`;
      await invoke("note_write", { dir, path, content: `# ${path.replace(/\.md$/, "")}\n\n` });
      setNewNoteName("");
      setNewNoteOpen(false);
      await refresh();
      await loadNote(path);
    });

  const syncState = !status
    ? "idle"
    : status.conflicts.length > 0
      ? "conflict"
      : status.pending
        ? "pending"
        : status.head === status.remoteMain
          ? "synced"
          : "local";

  const pill =
    syncState === "conflict"
      ? "bg-danger/10 text-danger"
      : syncState === "pending" || syncState === "local"
        ? "bg-warn/10 text-warn"
        : "bg-ok/10 text-ok";
  const dot =
    syncState === "conflict"
      ? "bg-danger"
      : syncState === "pending" || syncState === "local"
        ? "bg-warn"
        : "bg-ok";
  const pillLabel =
    syncState === "synced"
      ? "synced"
      : syncState === "local"
        ? "local only"
        : syncState === "pending"
          ? "unsaved"
          : syncState === "conflict"
            ? `${status?.conflicts.length} conflicts`
            : "no vault";

  const notesListHandlers = {
    notes,
    activeNote: notePath,
    onDelete: deleteNote,
  };

  const searchBox = (
    <div className="relative px-2 py-1.5">
      <Search
        size={13}
        className="absolute left-4 top-1/2 -translate-y-1/2 text-text-2"
      />
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search notes…"
        className="w-full rounded border border-border bg-surface-2 py-1 pl-7 pr-6 text-xs outline-none focus:border-accent"
      />
      {query && (
        <button
          onClick={() => setQuery("")}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-text-2 hover:text-text"
          title="clear"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );

  return (
    <div
      className="flex h-full flex-col pb-[env(safe-area-inset-bottom)]"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {/* header */}
      <header className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2 md:gap-3 md:px-4">
        <button
          onClick={() => setMenuOpen(true)}
          className="rounded p-1.5 text-text-2 hover:bg-surface-2 md:hidden"
          title="notes"
        >
          <Menu size={18} />
        </button>
        <span className="hidden text-sm font-semibold tracking-wide md:inline">md</span>

        {/* desktop vault actions */}
        <div className="hidden items-center gap-3 md:flex">
          <span
            className="max-w-40 truncate text-xs text-text-2"
            title={dir}
          >
            {dir.split("/").filter(Boolean).pop() ?? dir}
          </span>
          <button
            onClick={() => void pickVault()}
            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-surface-2"
          >
            <FolderOpen size={13} /> Open vault…
          </button>
        </div>

        {/* mobile: settings */}
        <button
          onClick={() => setSettingsOpen(true)}
          className="rounded p-1.5 text-text-2 hover:bg-surface-2 md:hidden"
          title="vault settings"
        >
          <Settings size={18} />
        </button>

        <div className="flex-1" />

        {/* sync status pill */}
        <span
          className={
            "flex items-center gap-1.5 rounded-full px-2 py-1 text-xs md:px-2.5 " + pill
          }
          title={
            status
              ? `head ${short(status.head)} · remote ${short(status.remoteMain)}` +
                (status.lastRun?.outcome ? ` · last run: ${status.lastRun.outcome}` : "")
              : "no vault open"
          }
        >
          <span className={"h-1.5 w-1.5 rounded-full " + dot} />
          <span className="hidden sm:inline">{pillLabel}</span>
        </span>

        <button
          onClick={doSync}
          disabled={busy || !status}
          className="flex items-center gap-1.5 rounded bg-accent px-2 py-1 text-xs text-accent-text hover:opacity-90 disabled:opacity-40 md:px-2.5"
        >
          <CloudUpload size={14} />
          <span className="hidden sm:inline">Sync</span>
        </button>
        <button
          onClick={() => setDark((d) => !d)}
          className="rounded p-1.5 text-text-2 hover:bg-surface-2"
          title="toggle theme"
        >
          {dark ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </header>

      {error && (
        <div className="bg-danger/10 px-4 py-1.5 text-xs text-danger">{error}</div>
      )}

      {/* body */}
      <div className="flex min-h-0 flex-1">
        {/* desktop sidebar */}
        <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-surface md:flex">
          {searchBox}
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs font-medium text-text-2">NOTES</span>
            <button
              onClick={() => setNewNoteOpen(true)}
              disabled={!status}
              className="rounded p-1 text-text-2 hover:bg-surface-2 disabled:opacity-40"
              title="new note"
            >
              <FilePlus2 size={14} />
            </button>
          </div>
          {searchHits ? (
            <SearchResults
              query={query}
              results={searchHits}
              activeNote={notePath}
              onPick={loadNote}
            />
          ) : (
            <NotesList {...notesListHandlers} onPick={loadNote} alwaysShowDelete={false} />
          )}
        </aside>

        {/* mobile drawer */}
        {menuOpen && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setMenuOpen(false)}
            />
            <div className="absolute inset-y-0 left-0 flex w-72 flex-col border-r border-border bg-surface shadow-xl">
              <div className="flex items-center justify-between px-3 py-2.5">
                <span className="text-xs font-medium text-text-2">NOTES</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      setNewNoteOpen(true);
                    }}
                    disabled={!status}
                    className="rounded p-1.5 text-text-2 hover:bg-surface-2 disabled:opacity-40"
                    title="new note"
                  >
                    <FilePlus2 size={16} />
                  </button>
                  <button
                    onClick={() => setMenuOpen(false)}
                    className="rounded p-1.5 text-text-2 hover:bg-surface-2"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
              {searchBox}
              {searchHits ? (
                <SearchResults
                  query={query}
                  results={searchHits}
                  activeNote={notePath}
                  onPick={(p) => {
                    setMenuOpen(false);
                    loadNote(p);
                  }}
                />
              ) : (
                <NotesList
                  {...notesListHandlers}
                  onPick={(p) => {
                    setMenuOpen(false);
                    loadNote(p);
                  }}
                  alwaysShowDelete
                />
              )}
            </div>
          </div>
        )}

        {/* editor */}
        <main className="flex min-w-0 flex-1 flex-col">
          {syncResult && (
            <div
              className={
                "px-4 py-1.5 text-xs " +
                (syncResult.conflicts.length > 0
                  ? "bg-danger/10 text-danger"
                  : syncResult.action.startsWith("no remote")
                    ? "bg-warn/10 text-warn"
                    : "bg-ok/10 text-ok")
              }
            >
              {syncResult.action} → {short(syncResult.head)}
              {syncResult.conflicts.length > 0 &&
                ` · ${syncResult.conflicts.length} conflicts`}
            </div>
          )}
          {status && status.conflicts.length > 0 && (
            <ConflictCard
              dir={dir}
              conflicts={status.conflicts}
              busy={busy}
              onResolved={doSync}
            />
          )}
          {notePath ? (
            <>
              <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-text-2 md:px-4">
                <span className="truncate">{notePath}</span>
                {dirty && <span className="text-warn">● unsaved</span>}
                <div className="flex-1" />
                <button
                  onClick={() => saveNote(body)}
                  disabled={busy || !dirty}
                  className="rounded border border-border px-2 py-0.5 hover:bg-surface-2 disabled:opacity-40"
                >
                  Save ⌘S
                </button>
              </div>
              <LiveMarkdownEditor body={body} onChange={onEditorChange} />
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-text-2">
              {status ? "select a note" : "open or init a vault to begin"}
            </div>
          )}
        </main>
      </div>

      {/* new note dialog (Base UI) */}
      <Dialog.Root open={newNoteOpen} onOpenChange={setNewNoteOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
          <Dialog.Popup className="fixed left-1/2 top-1/3 w-80 max-w-[90vw] -translate-x-1/2 rounded-lg border border-border bg-surface p-4 shadow-lg">
            <Dialog.Title className="mb-2 text-sm font-semibold">New note</Dialog.Title>
            <input
              autoFocus
              value={newNoteName}
              onChange={(e) => setNewNoteName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createNote()}
              placeholder="note name"
              className="w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Dialog.Close className="rounded px-2.5 py-1 text-xs hover:bg-surface-2">
                Cancel
              </Dialog.Close>
              <button
                onClick={createNote}
                className="rounded bg-accent px-2.5 py-1 text-xs text-accent-text hover:opacity-90"
              >
                Create
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      {/* vault settings dialog */}
      <Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
          <Dialog.Popup className="fixed left-1/2 top-1/4 w-96 max-w-[92vw] -translate-x-1/2 rounded-lg border border-border bg-surface p-4 shadow-lg">
            <Dialog.Title className="mb-3 text-sm font-semibold">Vault</Dialog.Title>
            <label className="mb-1 block text-xs text-text-2">folder</label>
            <div className="mb-3 flex gap-2">
              <input
                value={dir}
                readOnly
                className="min-w-0 flex-1 rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-text-2 outline-none"
              />
              <button
                onClick={() => {
                  setSettingsOpen(false);
                  void pickVault();
                }}
                className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-surface-2"
              >
                <FolderOpen size={13} /> Choose…
              </button>
            </div>
            <label className="mb-1 block text-xs text-text-2">
              git remote (optional — leave empty for a local-only vault)
            </label>
            <input
              value={setupRemote}
              onChange={(e) => setSetupRemote(e.target.value)}
              placeholder="https://github.com/you/notes.git"
              className="mb-4 w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
            <div className="flex justify-end gap-2">
              <Dialog.Close className="rounded px-2.5 py-1 text-xs hover:bg-surface-2">
                Cancel
              </Dialog.Close>
              <button
                onClick={() => {
                  void connectVault(
                    dir,
                    setupRemote.trim() ? setupRemote.trim() : null,
                  );
                  setSettingsOpen(false);
                }}
                disabled={busy}
                className="rounded bg-accent px-2.5 py-1 text-xs text-accent-text hover:opacity-90 disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      {/* vault setup dialog (picked folder is not a vault yet) */}
      <Dialog.Root open={setupDir !== null} onOpenChange={(o) => !o && setSetupDir(null)}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
          <Dialog.Popup className="fixed left-1/2 top-1/4 w-96 max-w-[92vw] -translate-x-1/2 rounded-lg border border-border bg-surface p-4 shadow-lg">
            <Dialog.Title className="mb-1 text-sm font-semibold">
              Set up this folder as a vault?
            </Dialog.Title>
            <p className="mb-3 text-xs text-text-2">
              <span className="font-mono">{setupDir}</span> is not a vault yet. We'll
              turn on Git tracking for it. Files stay plain markdown.
            </p>
            <label className="mb-1 block text-xs text-text-2">
              git remote (optional — you can add one later in settings)
            </label>
            <input
              value={setupRemote}
              onChange={(e) => setSetupRemote(e.target.value)}
              placeholder="https://github.com/you/notes.git"
              className="mb-4 w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
            <div className="flex justify-end gap-2">
              <Dialog.Close className="rounded px-2.5 py-1 text-xs hover:bg-surface-2">
                Cancel
              </Dialog.Close>
              <button
                onClick={() => void connectVault(setupDir!, setupRemote.trim() || null)}
                disabled={busy}
                className="rounded bg-accent px-2.5 py-1 text-xs text-accent-text hover:opacity-90 disabled:opacity-40"
              >
                Create vault
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

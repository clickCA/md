import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "@base-ui/react/dialog";
import { CloudUpload, FilePlus2, Moon, Sun, Trash2 } from "lucide-react";
import MarkdownEditor from "./components/MarkdownEditor";
import ConflictCard from "./components/ConflictCard";

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

const DEFAULT_DIR = "/tmp/md-vault";
const DEFAULT_REMOTE = "/tmp/md-remote.git";

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

  const refresh = useCallback(async () => {
    const [s, n] = await Promise.all([
      invoke<Status>("vault_status", { dir }),
      invoke<string[]>("note_list", { dir }),
    ]);
    setStatus(s);
    setNotes(n);
  }, [dir]);

  return { status, notes, error, busy, run, refresh, setError };
}

export default function App() {
  const [dir, setDir] = useState(DEFAULT_DIR);
  const [remoteUrl, setRemoteUrl] = useState(DEFAULT_REMOTE);
  const [dark, setDark] = useState(
    window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  const { status, notes, error, busy, run, refresh } = useVault(dir);

  const [notePath, setNotePath] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [dirty, setDirty] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  const [newNoteName, setNewNoteName] = useState("");
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

  const openVault = () => run("open", () => refresh());

  const initVault = () =>
    run("init", async () => {
      await invoke<Status>("vault_init", { dir, remoteUrl });
      await refresh();
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

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2">
        <span className="text-sm font-semibold tracking-wide">md</span>
        <input
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          className="w-56 rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text-2"
          placeholder="vault directory"
        />
        <input
          value={remoteUrl}
          onChange={(e) => setRemoteUrl(e.target.value)}
          className="w-56 rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text-2"
          placeholder="git remote"
        />
        <button
          onClick={openVault}
          disabled={busy}
          className="rounded px-2 py-1 text-xs hover:bg-surface-2"
        >
          Open
        </button>
        <button
          onClick={initVault}
          disabled={busy}
          className="rounded px-2 py-1 text-xs hover:bg-surface-2"
        >
          Init
        </button>

        <div className="flex-1" />

        {/* sync indicator */}
        <span
          className={
            "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs " +
            (syncState === "conflict"
              ? "bg-danger/10 text-danger"
              : syncState === "pending" || syncState === "local"
                ? "bg-warn/10 text-warn"
                : "bg-ok/10 text-ok")
          }
          title={
            status
              ? `head ${short(status.head)} · remote ${short(status.remoteMain)}` +
                (status.lastRun?.outcome ? ` · last run: ${status.lastRun.outcome}` : "")
              : "no vault open"
          }
        >
          <span
            className={
              "h-1.5 w-1.5 rounded-full " +
              (syncState === "conflict"
                ? "bg-danger"
                : syncState === "pending" || syncState === "local"
                  ? "bg-warn"
                  : "bg-ok")
            }
          />
          {syncState === "synced" && "synced"}
          {syncState === "local" && "local only"}
          {syncState === "pending" && "unsaved"}
          {syncState === "conflict" && `${status?.conflicts.length} conflicts`}
          {syncState === "idle" && "no vault"}
        </span>

        <button
          onClick={doSync}
          disabled={busy || !status}
          className="flex items-center gap-1.5 rounded bg-accent px-2.5 py-1 text-xs text-accent-text hover:opacity-90 disabled:opacity-40"
        >
          <CloudUpload size={13} /> Sync
        </button>
        <button
          onClick={() => setDark((d) => !d)}
          className="rounded p-1.5 text-text-2 hover:bg-surface-2"
          title="toggle theme"
        >
          {dark ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </header>

      {error && (
        <div className="bg-danger/10 px-4 py-1.5 text-xs text-danger">{error}</div>
      )}

      {/* body */}
      <div className="flex min-h-0 flex-1">
        {/* sidebar */}
        <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
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
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {notes.map((n) => (
              <li key={n} className="group flex items-center">
                <button
                  onClick={() => loadNote(n)}
                  className={
                    "flex-1 truncate px-3 py-1.5 text-left text-sm hover:bg-surface-2 " +
                    (n === notePath ? "font-medium text-accent" : "")
                  }
                >
                  {n}
                </button>
                <button
                  onClick={() => deleteNote(n)}
                  className="mr-1 hidden rounded p-1 text-text-2 hover:text-danger group-hover:block"
                  title="delete"
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
            {status && notes.length === 0 && (
              <li className="px-3 py-2 text-xs text-text-2">no notes yet</li>
            )}
          </ul>
        </aside>

        {/* editor */}
        <main className="flex min-w-0 flex-1 flex-col">
          {syncResult && (
            <div
              className={
                "px-4 py-1.5 text-xs " +
                (syncResult.conflicts.length > 0
                  ? "bg-danger/10 text-danger"
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
              <div className="flex items-center gap-2 border-b border-border px-4 py-1.5 text-xs text-text-2">
                <span>{notePath}</span>
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
              <MarkdownEditor
                path={notePath}
                initialBody={body}
                dark={dark}
                onChange={onEditorChange}
                onSave={() => void saveNote(body)}
              />
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-text-2">
              {status ? "select a note" : "open or init a vault to begin"}
            </div>
          )}
        </main>
      </div>

      {/* new note dialog (Base UI) */}
      <Dialog.Root open={newNoteOpen} onOpenChange={setNewNoteOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
          <Dialog.Popup className="fixed left-1/2 top-1/3 w-80 -translate-x-1/2 rounded-lg border border-border bg-surface p-4 shadow-lg">
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
    </div>
  );
}

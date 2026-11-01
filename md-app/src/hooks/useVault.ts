import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Creds, GitState, Status, SyncResult } from "../types";
import { errorMessage, isAuthError } from "../lib/ipc";
import { type VaultFile, fileName } from "../lib/vault";

export type SyncPhase = "idle" | "pulling" | "pushing" | "syncing";

export type SearchHit = { path: string; matches: { line: number; snippet: string }[] };

const baseName = (dir: string) => dir.split("/").filter(Boolean).pop() ?? dir;

/** Debounce window between the last edit and an automatic sync. */
const AUTOSYNC_DELAY_MS = 5_000;
const AUTOSYNC_KEY = "quire.autosync";

function readAutoSyncPref(): boolean {
  try {
    return localStorage.getItem(AUTOSYNC_KEY) !== "0";
  } catch {
    return true;
  }
}

export function useVault(dir: string) {
  const [status, setStatus] = useState<Status | null>(null);
  const [gitState, setGitState] = useState<GitState | null>(null);
  const [files, setFiles] = useState<VaultFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncPhase>("idle");
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [creds, setCreds] = useState<Creds | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [autoSync, setAutoSyncState] = useState<boolean>(readAutoSyncPref);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);

  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncingRef = useRef(false);
  /** Notes with in-memory edits that may not be on disk yet. */
  const dirtyRef = useRef<Set<string>>(new Set());
  /** Mirror of `files` for async merges — avoids stale closures. */
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  /** Mirror of the values async triggers need — avoids stale closures. */
  const ctxRef = useRef({ dir, creds, autoSync, hasRemote: false });
  useEffect(() => {
    ctxRef.current = { dir, creds, autoSync, hasRemote: !!gitState?.remoteUrl };
  }, [dir, creds, autoSync, gitState]);

  const setAutoSync = useCallback((on: boolean) => {
    setAutoSyncState(on);
    try {
      localStorage.setItem(AUTOSYNC_KEY, on ? "1" : "0");
    } catch {
      /* private mode — session-only */
    }
  }, []);

  const run = useCallback(
    async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await fn();
      } catch (e) {
        setError(`${label}: ${errorMessage(e)}`);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  /** Reload the whole vault: notes, contents, per-note git status. */
  const refresh = useCallback(
    async (d: string = dir) => {
      // One bulk command instead of a note_list + note_statuses +
      // note_read×N + note_base×M fan-out — every IPC re-opens the vault.
      const [notes, s, gs] = await Promise.all([
        invoke<{ path: string; content: string; committed: string | null }[]>("note_snapshot", {
          dir: d,
        }).catch(() => []),
        invoke<Status>("vault_status", { dir: d }),
        invoke<GitState>("git_state_cmd", { dir: d }).catch(() => null),
      ]);
      // Dirty notes keep their in-memory buffer: typing can now overlap a
      // background sync+refresh, and adopting stale disk content would
      // revert the editor mid-keystroke. The pending save re-lands on disk
      // and the next sync picks it up.
      const dirty = dirtyRef.current;
      const loaded = notes.map(({ path, content, committed }) => {
        if (dirty.has(path)) {
          const prev = filesRef.current.find((f) => f.path === path);
          if (prev) return prev;
        }
        return { path, content, committed };
      });
      setFiles(loaded);
      setStatus(s);
      setGitState(gs);
      setActive((prev) => (prev && loaded.some((f) => f.path === prev) ? prev : null));
    },
    [dir],
  );

  useEffect(() => {
    setActive(null);
    dirtyRef.current.clear();
    if (!dir) return;
    void run("open", () => refresh(dir));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);

  const activeFile = useMemo(() => files.find((f) => f.path === active) ?? null, [files, active]);

  /** Latest refresh for async triggers — avoids stale closures without TDZ. */
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  /**
   * Automatic, non-intrusive sync (the "immediate sync when the app is
   * active" promise). Never opens dialogs, never sets the global error —
   * failures land in lastSyncError for the git panel to surface. Auth
   * failures stay equally quiet: the user still has the manual button and
   * the credentials dialog; auto-sync must not nag.
   */
  const autoSyncNow = useCallback(async () => {
    const ctx = ctxRef.current;
    if (!ctx.autoSync || !ctx.hasRemote || !ctx.dir || syncingRef.current) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    syncingRef.current = true;
    setSync("syncing");
    try {
      const r = await invoke<SyncResult>("vault_sync", {
        dir: ctx.dir,
        credentials: ctx.creds,
      });
      setSyncResult(r);
      setLastSyncError(null);
      await refreshRef.current(ctx.dir);
    } catch (e) {
      if (!isAuthError(e)) setLastSyncError(errorMessage(e));
    } finally {
      syncingRef.current = false;
      setSync("idle");
    }
  }, []);

  /** Debounced trigger — used after every note mutation. */
  const scheduleAutoSync = useCallback(
    (delay: number = AUTOSYNC_DELAY_MS) => {
      if (autoTimer.current) clearTimeout(autoTimer.current);
      autoTimer.current = setTimeout(() => {
        autoTimer.current = null;
        void autoSyncNow();
      }, delay);
    },
    [autoSyncNow],
  );

  // Sync when the app becomes active again (regained focus / re-shown).
  useEffect(() => {
    const onActive = () => {
      if (document.visibilityState === "visible") void autoSyncNow();
    };
    document.addEventListener("visibilitychange", onActive);
    window.addEventListener("focus", onActive);
    return () => {
      document.removeEventListener("visibilitychange", onActive);
      window.removeEventListener("focus", onActive);
    };
  }, [autoSyncNow]);

  // Don't leak a pending timer across vault switches or unmount.
  useEffect(
    () => () => {
      if (autoTimer.current) clearTimeout(autoTimer.current);
    },
    [],
  );

  const changes = useMemo(
    () => files.filter((f) => f.committed === null || f.content !== f.committed),
    [files],
  );

  const open = useCallback((path: string) => {
    setActive(path);
  }, []);

  const setContent = useCallback((path: string, content: string) => {
    dirtyRef.current.add(path);
    setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, content } : f)));
  }, []);

  const writeNote = useCallback(
    async (path: string, content: string) =>
      run("write", async () => {
        await invoke("note_write", { dir, path, content });
        dirtyRef.current.delete(path);
        scheduleAutoSync();
      }),
    [dir, run, scheduleAutoSync],
  );

  const createNote = useCallback(
    async (rawName?: string) => {
      const taken = new Set(files.map((f) => f.path));
      let path: string;
      if (rawName && rawName.trim()) {
        const base = rawName.trim().replace(/\.md$/, "");
        path = `${base}.md`;
        let n = 2;
        while (taken.has(path)) path = `${base} ${n++}.md`;
      } else {
        let n = 1;
        const names = new Set(files.map((f) => fileName(f.path)));
        while (names.has(`Untitled ${n}`)) n++;
        path = `Untitled ${n}.md`;
      }
      await run("create", async () => {
        await invoke("note_write", { dir, path, content: `# ${fileName(path)}\n\n` });
        await refresh();
        setActive(path);
        scheduleAutoSync();
      });
    },
    [dir, files, run, refresh, scheduleAutoSync],
  );

  const createFolder = useCallback(
    async (name: string) => {
      await run("folder", async () => {
        await invoke("folder_create", { dir, path: name });
      });
    },
    [dir, run],
  );

  const deleteNote = useCallback(
    async (path: string) => {
      await run("delete", async () => {
        await invoke("note_delete", { dir, path });
        dirtyRef.current.delete(path);
        if (active === path) setActive(null);
        await refresh();
        scheduleAutoSync();
      });
    },
    [dir, run, active, refresh, scheduleAutoSync],
  );

  /** Reveal a note in the OS file manager (context menu action). */
  const revealNote = useCallback(
    async (path: string) =>
      run("reveal", async () => {
        const abs = await invoke<string>("vault_path", { dir, path });
        await revealItemInDir(abs);
      }),
    [dir, run],
  );

  const moveNote = useCallback(
    async (from: string, toFolder: string) => {
      const name = from.split("/").pop()!;
      const to = toFolder ? `${toFolder}/${name}` : name;
      if (to === from) return;
      await run("move", async () => {
        await invoke("note_move", { dir, from, to });
        for (const p of [...dirtyRef.current]) {
          if (p === from) {
            dirtyRef.current.delete(p);
            dirtyRef.current.add(to);
          } else if (p.startsWith(`${from}/`)) {
            dirtyRef.current.delete(p);
            dirtyRef.current.add(to + p.slice(from.length));
          }
        }
        setFiles((prev) =>
          prev.map((f) => ({
            ...f,
            path:
              f.path === from
                ? to
                : f.path.startsWith(`${from}/`)
                  ? to + f.path.slice(from.length)
                  : f.path,
          })),
        );
        setActive((prev) => (prev === from ? to : prev));
        await refresh();
        scheduleAutoSync();
      });
    },
    [dir, run, refresh, scheduleAutoSync],
  );

  const syncNow = useCallback(
    async (c?: Creds | null) => {
      setSync("syncing");
      await run("sync", async () => {
        try {
          const r = await invoke<SyncResult>("vault_sync", { dir, credentials: c ?? creds });
          setSyncResult(r);
          setLastSyncError(null);
        } catch (e) {
          if (isAuthError(e)) {
            setAuthOpen(true);
            return;
          }
          throw e;
        }
        await refresh();
      });
      setSync("idle");
    },
    [dir, run, refresh, creds],
  );

  const gitAction = useCallback(
    async (action: string) => {
      setSync(action === "push" ? "pushing" : "pulling");
      await run(action, async () => {
        try {
          await invoke("git_action", { dir, action, credentials: creds });
        } catch (e) {
          if (isAuthError(e)) {
            setAuthOpen(true);
            return;
          }
          throw e;
        }
        await refresh();
      });
      setSync("idle");
    },
    [dir, run, refresh, creds],
  );

  const search = useCallback(
    async (query: string): Promise<SearchHit[]> => {
      const q = query.trim();
      if (!q) return [];
      try {
        return await invoke<SearchHit[]>("search_notes", { dir, query: q });
      } catch {
        return [];
      }
    },
    [dir],
  );

  const onSignIn = useCallback(
    (c: Creds) => {
      setCreds(c);
      void syncNow(c);
    },
    [syncNow],
  );

  return {
    dir,
    name: baseName(dir),
    status,
    gitState,
    files,
    active,
    activeFile,
    changes,
    busy,
    error,
    sync,
    syncResult,
    authOpen,
    setAuthOpen,
    onSignIn,
    setError,
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
    search,
    refresh,
    run,
    autoSync,
    setAutoSync,
    lastSyncError,
  };
}

export type Vault = ReturnType<typeof useVault>;

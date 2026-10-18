import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Creds, GitState, Status, SyncResult } from "../types";
import { type GitStatus, type VaultFile, fileName } from "../lib/vault";

export type SyncPhase = "idle" | "pulling" | "pushing" | "syncing";

export type SearchHit = { path: string; matches: { line: number; snippet: string }[] };

type NoteStatusDto = { path: string; status: GitStatus };

const baseName = (dir: string) => dir.split("/").filter(Boolean).pop() ?? dir;

/** Backend auth failures vary by transport (git2 vs gix); match loosely. */
const isAuthError = (e: unknown) => /auth|credential/i.test(String(e));

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

  const run = useCallback(
    async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await fn();
      } catch (e) {
        setError(`${label}: ${e}`);
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
      const [paths, statuses, s, gs] = await Promise.all([
        invoke<string[]>("note_list", { dir: d }),
        invoke<NoteStatusDto[]>("note_statuses", { dir: d }).catch(() => [] as NoteStatusDto[]),
        invoke<Status>("vault_status", { dir: d }),
        invoke<GitState>("git_state_cmd", { dir: d }).catch(() => null),
      ]);
      const statusOfPath = new Map(statuses.map((n) => [n.path, n.status]));
      const loaded = await Promise.all(
        paths.map(async (path): Promise<VaultFile> => {
          const content = await invoke<string>("note_read", { dir: d, path }).catch(() => "");
          const state = statusOfPath.get(path) ?? "clean";
          if (state === "clean") return { path, content, committed: content };
          if (state === "untracked") return { path, content, committed: null };
          const base = await invoke<string | null>("note_base", { dir: d, path }).catch(() => null);
          return { path, content, committed: base };
        }),
      );
      setFiles(loaded);
      setStatus(s);
      setGitState(gs);
      setActive((prev) => (prev && loaded.some((f) => f.path === prev) ? prev : null));
    },
    [dir],
  );

  useEffect(() => {
    setActive(null);
    if (!dir) return;
    void run("open", () => refresh(dir));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);

  const activeFile = useMemo(() => files.find((f) => f.path === active) ?? null, [files, active]);

  const changes = useMemo(() => files.filter((f) => f.committed === null || f.content !== f.committed), [files]);

  const open = useCallback((path: string) => {
    setActive(path);
  }, []);

  const setContent = useCallback((path: string, content: string) => {
    setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, content } : f)));
  }, []);

  const writeNote = useCallback(
    async (path: string, content: string) =>
      run("write", async () => {
        await invoke("note_write", { dir, path, content });
      }),
    [dir, run],
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
      });
    },
    [dir, files, run, refresh],
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
        if (active === path) setActive(null);
        await refresh();
      });
    },
    [dir, run, active, refresh],
  );

  const moveNote = useCallback(
    async (from: string, toFolder: string) => {
      const name = from.split("/").pop()!;
      const to = toFolder ? `${toFolder}/${name}` : name;
      if (to === from) return;
      await run("move", async () => {
        await invoke("note_move", { dir, from, to });
        setFiles((prev) =>
          prev.map((f) => ({
            ...f,
            path: f.path === from ? to : f.path.startsWith(`${from}/`) ? to + f.path.slice(from.length) : f.path,
          })),
        );
        setActive((prev) => (prev === from ? to : prev));
        await refresh();
      });
    },
    [dir, run, refresh],
  );

  const syncNow = useCallback(
    async (c?: Creds | null) => {
      setSync("syncing");
      await run("sync", async () => {
        try {
          const r = await invoke<SyncResult>("vault_sync", { dir, credentials: c ?? creds });
          setSyncResult(r);
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
    moveNote,
    syncNow,
    gitAction,
    search,
    refresh,
    run,
  };
}

export type Vault = ReturnType<typeof useVault>;

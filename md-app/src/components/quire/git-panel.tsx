import { type ReactNode, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  GitBranch,
  GitCommitHorizontal,
  History,
  PenLine,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Upload,
} from "lucide-react";
import type { Branches, CommitInfo, HistoryEntry, Journal } from "@/types";
import { type VaultFile, eventLabel, fileName, relTime, statusOf } from "@/lib/vault";
import { cn } from "@/lib/utils";
import { PanelHeader } from "./panel-header";

export type GitPanelProps = {
  name: string;
  isRepo: boolean;
  hasRemote: boolean;
  relation: string;
  /** Branch HEAD points at; commits and pushes follow it. */
  branch: string;
  head: string | null;
  remoteHead: string | null;
  changes: VaultFile[];
  sync: "idle" | "pulling" | "pushing" | "syncing";
  lastRun: Journal | null;
  lastSyncError: string | null;
  /** Note open in the editor; the note-scoped history follows it. */
  activePath: string | null;
  loadNoteHistory: (path: string) => Promise<HistoryEntry[]>;
  loadVaultHistory: () => Promise<CommitInfo[]>;
  /** Open a revision read-only in the main area. */
  onShowRevision: (entry: HistoryEntry) => void;
  /** Vault-level snapshot restore (two-step confirm in the panel). */
  onRestoreSnapshot: (oid: string) => void;
  loadBranches: () => Promise<Branches>;
  onSwitchBranch: (name: string) => void;
  onCreateBranch: (name: string) => Promise<void>;
  onOpen: (path: string) => void;
  /** Open the note's uncommitted changes in the diff viewer. */
  onShowDiff: (path: string) => void;
  /** Note currently shown in the diff viewer; its row is highlighted. */
  diffPath?: string | null;
  onSync: () => void;
  onGitAction: (action: string) => void;
  onInit: () => void;
};

const short = (oid: string | null) => (oid ? oid.slice(0, 7) : "—");

export function GitPanel({
  name,
  isRepo,
  hasRemote,
  relation,
  branch,
  head,
  remoteHead,
  changes,
  sync,
  lastRun,
  lastSyncError,
  activePath,
  loadNoteHistory,
  loadVaultHistory,
  onShowRevision,
  onRestoreSnapshot,
  loadBranches,
  onSwitchBranch,
  onCreateBranch,
  onOpen,
  onShowDiff,
  diffPath,
  onSync,
  onGitAction,
  onInit,
}: GitPanelProps) {
  const [confirmForce, setConfirmForce] = useState(false);
  const busy = sync !== "idle";

  if (!isRepo) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader title="Source control" />
        <div className="flex flex-col gap-3 px-3 pt-2">
          <div className="flex size-9 items-center justify-center rounded-md bg-accent">
            <GitBranch className="size-4 text-primary" aria-hidden />
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="text-[13px] font-medium">Not a git repository</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Initialize git in <span className="font-mono text-foreground">{name}/</span> to
              version your notes and sync them across devices.
            </p>
          </div>
          <button
            type="button"
            onClick={onInit}
            disabled={busy}
            className="flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <GitBranch className="size-3.5" aria-hidden />
            Initialize repository
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Source control">
        <IconButton label="Sync now" onClick={onSync} disabled={busy || !hasRemote}>
          <RefreshCw className={cn("size-3.5", busy && "animate-spin")} aria-hidden />
        </IconButton>
      </PanelHeader>

      <div className="flex flex-col gap-2 px-3 pb-3">
        <div className="flex flex-col gap-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
          <div className="flex items-center justify-between">
            <span className="truncate" title={head ?? ""}>
              <GitBranch className="mr-1 inline size-3" aria-hidden />
              <span className="text-foreground">{branch}</span> {short(head)}
            </span>
            <span className="flex items-center gap-1" title={`relation: ${relation}`}>
              {relation === "ahead" && <ArrowUp className="size-3" aria-hidden />}
              {relation === "behind" && <ArrowDown className="size-3" aria-hidden />}
              <span className="text-foreground">{relation}</span>
            </span>
          </div>
          {hasRemote && (
            <div className="truncate">
              origin/{branch} {short(remoteHead)}
            </div>
          )}
        </div>

        <BranchesSection
          key={branch}
          branch={branch}
          loadBranches={loadBranches}
          onSwitchBranch={onSwitchBranch}
          onCreateBranch={onCreateBranch}
          disabled={busy}
        />

        {hasRemote ? (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onGitAction("take-remote")}
              disabled={busy}
              className="flex h-7 items-center justify-center gap-1.5 rounded-md border border-border text-xs text-foreground hover:bg-accent disabled:opacity-50"
              title="take the remote state verbatim"
            >
              <ArrowDown className="size-3.5" aria-hidden />
              Pull
            </button>
            <button
              type="button"
              onClick={() => onGitAction("push")}
              disabled={busy}
              className="flex h-7 items-center justify-center gap-1.5 rounded-md border border-border text-xs text-foreground hover:bg-accent disabled:opacity-50"
              title="commit pending changes and push"
            >
              <ArrowUp className="size-3.5" aria-hidden />
              Push
            </button>
          </div>
        ) : (
          <p className="rounded-md border border-dashed border-border px-2 py-1.5 text-[11px] text-muted-foreground">
            No remote yet. Add one in vault settings to sync across devices.
          </p>
        )}

        <button
          type="button"
          onClick={onSync}
          disabled={busy || !hasRemote}
          className="flex h-7 items-center justify-center gap-1.5 rounded-md bg-primary text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          <Upload className="size-3.5" aria-hidden />
          Sync now
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pb-4">
        <ChangeGroup
          title="Changes"
          files={changes}
          onOpen={onOpen}
          onShowDiff={onShowDiff}
          diffPath={diffPath}
          headerAction={
            changes.length > 0 && (
              <span className="font-mono text-[11px] text-muted-foreground">{changes.length}</span>
            )
          }
        />

        {/* Keyed on the active note so switching notes resets the scoped
            history instead of showing a stale note's revisions. */}
        <HistorySection
          key={activePath ?? "none"}
          activePath={activePath}
          loadNoteHistory={loadNoteHistory}
          loadVaultHistory={loadVaultHistory}
          onShowRevision={onShowRevision}
          onRestoreSnapshot={onRestoreSnapshot}
          disabled={busy}
        />

        <section className="mt-3 px-1.5">
          {lastSyncError && (
            <div
              className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] leading-snug text-destructive"
              role="status"
              title={lastSyncError}
            >
              background sync failed —{" "}
              {lastSyncError.length > 90 ? `${lastSyncError.slice(0, 90)}…` : lastSyncError}
            </div>
          )}
          <div className="flex h-6 items-center justify-between px-2">
            <h3 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
              Recent sync
            </h3>
            {lastRun && (
              <span
                className={cn(
                  "font-mono text-[11px]",
                  lastRun.outcome === "error"
                    ? "text-destructive"
                    : lastRun.outcome === "conflicts"
                      ? "text-modified"
                      : "text-muted-foreground",
                )}
              >
                {relTime(lastRun.finishedAt ?? lastRun.startedAt)}
              </span>
            )}
          </div>
          {lastRun && lastRun.events.length > 0 ? (
            <ol className="relative">
              {lastRun.events.map(([at, state], i) => (
                <li
                  key={`${i}-${state}-${at}`}
                  className="relative flex gap-2.5 rounded-md px-2 py-1.5 hover:bg-sidebar-accent"
                >
                  <span className="relative flex w-3 shrink-0 justify-center pt-1">
                    {i < lastRun.events.length - 1 && (
                      <span className="absolute top-3 -bottom-3 w-px bg-border" aria-hidden />
                    )}
                    <GitCommitHorizontal
                      className={cn(
                        "relative size-3",
                        i === lastRun.events.length - 1 ? "text-primary" : "text-muted-foreground",
                      )}
                      aria-hidden
                    />
                  </span>
                  <span className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
                    <span className="truncate text-[13px] leading-5">{eventLabel(state)}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {relTime(at)}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="px-2 py-1 text-xs text-muted-foreground">No sync runs yet.</p>
          )}

          <button
            type="button"
            onClick={() => {
              if (!confirmForce) {
                setConfirmForce(true);
                return;
              }
              setConfirmForce(false);
              onGitAction("force-publish");
            }}
            disabled={busy || !hasRemote}
            className={cn(
              "mt-3 flex h-7 w-full items-center justify-center gap-1.5 rounded-md text-[11px] disabled:opacity-40",
              confirmForce
                ? "bg-destructive text-destructive-foreground"
                : "border border-border text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            title="overwrite the remote with local history"
          >
            <ShieldAlert className="size-3.5" aria-hidden />
            {confirmForce ? "Really overwrite remote?" : "Force publish"}
          </button>
        </section>
      </div>
    </div>
  );
}

function ChangeGroup({
  title,
  files,
  onOpen,
  onShowDiff,
  diffPath,
  headerAction,
}: {
  title: string;
  files: VaultFile[];
  onOpen: (path: string) => void;
  onShowDiff: (path: string) => void;
  diffPath?: string | null;
  headerAction?: ReactNode;
}) {
  return (
    <section className="px-1.5 pt-1">
      <div className="flex h-6 items-center justify-between px-2">
        <h3 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          {title} <span className="font-mono">{files.length}</span>
        </h3>
        {headerAction}
      </div>
      {files.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">Working tree clean.</p>
      ) : (
        <ul>
          {files.map((f) => {
            const status = statusOf(f);
            const diffing = f.path === diffPath;
            return (
              <li
                key={f.path}
                className={cn(
                  "group flex h-7 items-center gap-1 rounded-md pr-1 hover:bg-sidebar-accent",
                  diffing && "bg-sidebar-accent",
                )}
              >
                {/* Primary action: view the uncommitted diff (VS Code-style
                    SCM navigation); editing stays one click away. */}
                <button
                  type="button"
                  onClick={() => onShowDiff(f.path)}
                  aria-label={`Diff ${f.path}`}
                  aria-current={diffing || undefined}
                  title="View diff"
                  className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 text-left"
                >
                  <span className="min-w-0 truncate text-[13px]">{fileName(f.path)}</span>
                  <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                    {f.path.includes("/") ? f.path.split("/").slice(0, -1).join("/") : ""}
                  </span>
                </button>
                <span
                  className={cn(
                    "w-3 font-mono text-[10px]",
                    status === "modified" ? "text-modified" : "text-added",
                  )}
                >
                  {status === "modified" ? "M" : "U"}
                </span>
                <button
                  type="button"
                  aria-label={`Edit ${f.path}`}
                  title="Edit note"
                  onClick={() => onOpen(f.path)}
                  className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <PenLine className="size-3.5" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** Branch picker (plan P2 "Branches"): switch with a clean tree only —
    the backend refuses a dirty vault, so nothing is ever lost. Creating a
    branch never switches; loading is event-driven (open / create). */
function BranchesSection({
  branch,
  loadBranches,
  onSwitchBranch,
  onCreateBranch,
  disabled,
}: {
  branch: string;
  loadBranches: () => Promise<Branches>;
  onSwitchBranch: (name: string) => void;
  onCreateBranch: (name: string) => Promise<void>;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      setNames((await loadBranches()).branches);
    } catch {
      setError("Could not load branches.");
    }
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      await onCreateBranch(name);
      setNewName("");
      setCreating(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the branch.");
    }
  };

  return (
    <section>
      <div className="flex h-6 items-center justify-between px-2">
        <button
          type="button"
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next && names.length === 0) void load();
          }}
          aria-expanded={open}
          className="flex h-5 items-center gap-1.5 rounded px-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase hover:bg-accent hover:text-foreground"
        >
          <GitBranch className="size-3" aria-hidden />
          Branches
          <span className="font-mono normal-case">{branch}</span>
        </button>
        <IconButton
          label={creating ? "Cancel new branch" : "New branch"}
          onClick={() => setCreating((c) => !c)}
          disabled={disabled}
        >
          <span className="font-mono text-[13px] leading-none" aria-hidden>
            {creating ? "\u00d7" : "+"}
          </span>
        </IconButton>
      </div>

      {(open || creating) && (
        <div className="px-1 pb-1">
          {creating && (
            <div className="mb-1 flex items-center gap-1 px-1">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void create();
                }}
                placeholder="new-branch-name"
                aria-label="New branch name"
                autoFocus
                className="h-6 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-[11px] outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={() => void create()}
                disabled={disabled || !newName.trim()}
                className="flex h-6 shrink-0 items-center rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground disabled:opacity-40"
              >
                Create
              </button>
            </div>
          )}
          {error && (
            <p className="px-1 py-0.5 text-[11px] text-destructive" role="alert">
              {error}
            </p>
          )}
          {open &&
            (names.length === 0 ? (
              <p className="px-1 py-0.5 text-[11px] text-muted-foreground" role="status">
                {error ? null : "Loading\u2026"}
              </p>
            ) : (
              <ul>
                {names.map((n) => (
                  <li key={n}>
                    <button
                      type="button"
                      onClick={() => n !== branch && onSwitchBranch(n)}
                      disabled={disabled || n === branch}
                      title={
                        n === branch
                          ? "current branch"
                          : "switch \u2014 refused while there are uncommitted changes"
                      }
                      className={cn(
                        "flex h-6 w-full items-center gap-2 rounded-md px-1 text-left text-[12px] hover:bg-sidebar-accent disabled:opacity-60",
                        n === branch ? "font-medium text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          n === branch ? "bg-primary" : "bg-transparent",
                        )}
                        aria-hidden
                      />
                      <span className="truncate font-mono">{n}</span>
                      {n === branch && (
                        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                          current
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      )}
    </section>
  );
}

/** History browse + restore (plan P1 "History"): path-aware note history
    and the vault-wide log. Loading is event-driven (open / switch scope) —
    no effects, so switching notes resets via the section key. */
function HistorySection({
  activePath,
  loadNoteHistory,
  loadVaultHistory,
  onShowRevision,
  onRestoreSnapshot,
  disabled,
}: {
  activePath: string | null;
  loadNoteHistory: (path: string) => Promise<HistoryEntry[]>;
  loadVaultHistory: () => Promise<CommitInfo[]>;
  onShowRevision: (entry: HistoryEntry) => void;
  onRestoreSnapshot: (oid: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"note" | "vault">("note");
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmSnapshot, setConfirmSnapshot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (forScope: "note" | "vault") => {
    setLoading(true);
    setError(null);
    try {
      if (forScope === "note") {
        if (!activePath) return;
        setEntries(await loadNoteHistory(activePath));
      } else {
        setCommits(await loadVaultHistory());
      }
    } catch {
      setError("Could not load history.");
    } finally {
      setLoading(false);
    }
  };

  const toggle = (next: "note" | "vault") => {
    if (next === "note" && !activePath) return;
    setScope(next);
    setOpen(true);
    void load(next);
  };

  return (
    <section className="mt-3 px-1.5">
      <div className="flex h-6 items-center justify-between px-2">
        <h3 className="flex items-center gap-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          <History className="size-3" aria-hidden />
          History
        </h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => toggle("note")}
            disabled={!activePath}
            title={activePath ? `History of ${activePath}` : "open a note to browse its history"}
            className={cn(
              "h-5 rounded px-1.5 text-[10px] transition-colors",
              open && scope === "note"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
              !activePath && "cursor-not-allowed opacity-40",
            )}
          >
            Note
          </button>
          <button
            type="button"
            onClick={() => toggle("vault")}
            disabled={open && scope === "vault"}
            className={cn(
              "h-5 rounded px-1.5 text-[10px] transition-colors",
              open && scope === "vault"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            Vault
          </button>
          <IconButton
            label={open ? "Hide history" : "Show history"}
            onClick={() => {
              const next = !open;
              setOpen(next);
              if (next && entries.length === 0 && commits.length === 0) void load(scope);
            }}
            disabled={disabled || (scope === "note" && !activePath)}
          >
            <span
              className={cn(
                "font-mono text-[11px] text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
              aria-hidden
            >
              ▸
            </span>
          </IconButton>
        </div>
      </div>

      {open &&
        (scope === "note" && !activePath ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            Open a note to browse its history.
          </p>
        ) : loading ? (
          <p className="px-2 py-1 text-xs text-muted-foreground" role="status">
            Loading…
          </p>
        ) : error ? (
          <p className="px-2 py-1 text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : scope === "note" ? (
          entries.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">No committed history yet.</p>
          ) : (
            <ol>
              {entries.map((e) => (
                <li key={`${e.oid}-${e.path}-${e.change}`}>
                  <button
                    type="button"
                    onClick={() => onShowRevision(e)}
                    title={`View revision of ${e.message}`}
                    className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-sidebar-accent"
                  >
                    <span
                      className={cn(
                        "w-3 shrink-0 text-center font-mono text-[10px]",
                        e.change === "deleted"
                          ? "text-destructive"
                          : e.change === "added"
                            ? "text-added"
                            : "text-modified",
                      )}
                    >
                      {e.change === "added" ? "A" : e.change === "deleted" ? "D" : "M"}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] leading-5">
                      {e.message}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {relTime(String(e.time))}
                    </span>
                    <span className="w-7 shrink-0 truncate font-mono text-[10px] text-muted-foreground">
                      {e.oid.slice(0, 7)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )
        ) : (
          <div>
            {commits.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">No committed history yet.</p>
            ) : (
              <ol>
                {commits.map((c) => (
                  <li
                    key={c.oid}
                    className="flex h-7 items-center gap-2 rounded-md px-2 hover:bg-sidebar-accent"
                  >
                    <GitCommitHorizontal
                      className="size-3 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px] leading-5">
                      {c.message}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {relTime(String(c.time))}
                    </span>
                    <button
                      type="button"
                      aria-label={`Restore snapshot ${c.oid.slice(0, 7)}`}
                      title="Write every note present at this revision back (later notes stay)"
                      onClick={() => {
                        if (confirmSnapshot !== c.oid) {
                          setConfirmSnapshot(c.oid);
                          return;
                        }
                        setConfirmSnapshot(null);
                        onRestoreSnapshot(c.oid);
                      }}
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded",
                        confirmSnapshot === c.oid
                          ? "bg-destructive text-destructive-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      <RotateCcw className="size-3.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        ))}
    </section>
  );
}

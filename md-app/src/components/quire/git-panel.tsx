import { type ReactNode, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  GitBranch,
  GitCommitHorizontal,
  RefreshCw,
  ShieldAlert,
  Upload,
} from "lucide-react";
import type { Journal } from "@/types";
import { type VaultFile, eventLabel, fileName, relTime, statusOf } from "@/lib/vault";
import { cn } from "@/lib/utils";
import { PanelHeader } from "./panel-header";

export type GitPanelProps = {
  name: string;
  isRepo: boolean;
  hasRemote: boolean;
  relation: string;
  head: string | null;
  remoteHead: string | null;
  changes: VaultFile[];
  sync: "idle" | "pulling" | "pushing" | "syncing";
  lastRun: Journal | null;
  lastSyncError: string | null;
  onOpen: (path: string) => void;
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
  head,
  remoteHead,
  changes,
  sync,
  lastRun,
  lastSyncError,
  onOpen,
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
              <span className="text-foreground">main</span> {short(head)}
            </span>
            <span className="flex items-center gap-1" title={`relation: ${relation}`}>
              {relation === "ahead" && <ArrowUp className="size-3" aria-hidden />}
              {relation === "behind" && <ArrowDown className="size-3" aria-hidden />}
              <span className="text-foreground">{relation}</span>
            </span>
          </div>
          {hasRemote && <div className="truncate">origin/main {short(remoteHead)}</div>}
        </div>

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
          headerAction={
            changes.length > 0 && (
              <span className="font-mono text-[11px] text-muted-foreground">{changes.length}</span>
            )
          }
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
  headerAction,
}: {
  title: string;
  files: VaultFile[];
  onOpen: (path: string) => void;
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
            return (
              <li
                key={f.path}
                className="group flex h-7 items-center gap-1 rounded-md pr-1 hover:bg-sidebar-accent"
              >
                <button
                  type="button"
                  onClick={() => onOpen(f.path)}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 text-left"
                >
                  <span className="truncate text-[13px]">{fileName(f.path)}</span>
                  <span className="truncate text-[11px] text-muted-foreground">
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

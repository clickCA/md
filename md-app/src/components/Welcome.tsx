import { FileText, FolderOpen, FolderPlus, GitFork, List, Moon, Sun } from "lucide-react";

type Props = {
  busy: boolean;
  dark: boolean;
  isMobile: boolean;
  /** Desktop: resolved default vault location, shown as the one-click target. */
  defaultDir: string;
  /** Mobile: app-sandboxed vaults home container. */
  vaultsHome: string;
  /** Mobile: existing sandboxed vaults (opts the picker button in). */
  vaultCount: number;
  onToggleTheme: () => void;
  /** Desktop: native folder picker / one-click create at the default dir. */
  onOpenFolder: () => void;
  onCreateVault: () => void;
  /** Mobile: open the create/clone dialog (no folder picker exists). */
  onCreateRequested: () => void;
  onCloneRequested: () => void;
  onListVaults: () => void;
};

/** In-app first-run screen. Desktop: open/make a vault at a real path.
    Mobile: the app is sandboxed, so it's a vault manager — create, clone, pick. */
export function Welcome({
  busy,
  dark,
  isMobile,
  defaultDir,
  vaultsHome,
  vaultCount,
  onToggleTheme,
  onOpenFolder,
  onCreateVault,
  onCreateRequested,
  onCloneRequested,
  onListVaults,
}: Props) {
  return (
    <div className="relative grid h-dvh place-items-center">
      <button
        type="button"
        onClick={onToggleTheme}
        aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
        className="absolute top-5 right-6 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        {dark ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
      </button>

      <div className="flex flex-col items-center pb-16 text-center">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-md bg-primary text-primary-foreground">
            <FileText className="size-5" aria-hidden />
          </span>
          <span className="font-mono text-lg font-bold tracking-tight text-heading">md</span>
        </div>
        <p className="max-w-xs text-pretty text-sm leading-relaxed text-muted-foreground">
          A local-first markdown vault — plain files on disk, git-backed sync underneath.
        </p>

        {isMobile ? (
          <div className="mt-6 flex w-56 flex-col items-stretch gap-2">
            <button
              type="button"
              onClick={onCreateRequested}
              disabled={busy}
              className="flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
            >
              <FolderPlus className="size-4" aria-hidden />
              Create new vault
            </button>
            <button
              type="button"
              onClick={onCloneRequested}
              disabled={busy}
              className="flex items-center justify-center gap-2 rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-40"
            >
              <GitFork className="size-4" aria-hidden />
              Clone from URL…
            </button>
            {vaultCount > 0 && (
              <button
                type="button"
                onClick={onListVaults}
                disabled={busy}
                className="flex items-center justify-center gap-2 rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-40"
              >
                <List className="size-4" aria-hidden />
                Vaults ({vaultCount})
              </button>
            )}
          </div>
        ) : (
          <div className="mt-6 flex items-center gap-3">
            <button
              type="button"
              onClick={onCreateVault}
              disabled={busy}
              className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
            >
              <FolderPlus className="size-4" aria-hidden />
              Create new vault
            </button>
            <button
              type="button"
              onClick={onOpenFolder}
              disabled={busy}
              className="flex items-center gap-2 rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-40"
            >
              <FolderOpen className="size-4" aria-hidden />
              Open folder…
            </button>
          </div>
        )}

        <p className="mt-4 font-mono text-xs text-muted-foreground">
          {isMobile ? (
            <>
              vaults are saved on this device in{" "}
              <span className="break-all text-foreground/80">{vaultsHome || "app storage"}</span>
            </>
          ) : (
            <>
              first vault lands in <span className="text-foreground/80">{defaultDir}</span>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

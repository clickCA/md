import { FileText, FolderOpen, FolderPlus, Moon, Sun } from "lucide-react";

type Props = {
  busy: boolean;
  dark: boolean;
  /** Resolved default vault location, shown as the one-click target. */
  defaultDir: string;
  onToggleTheme: () => void;
  onOpenFolder: () => void;
  onCreateVault: () => void;
};

/** In-app first-run screen: what the desktop app shows when the boot folder
    isn't a vault yet. The marketing page lives in the standalone `landing`
    workspace package — this is only the utility front door. */
export function Welcome({
  busy,
  dark,
  defaultDir,
  onToggleTheme,
  onOpenFolder,
  onCreateVault,
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
        <p className="mt-4 font-mono text-xs text-muted-foreground">
          first vault lands in <span className="text-foreground/80">{defaultDir}</span>
        </p>
      </div>
    </div>
  );
}

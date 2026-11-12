import { Download, X } from "lucide-react";
import type { Update } from "@tauri-apps/plugin-updater";

type Props = {
  update: Update | null;
  installing: boolean;
  error: string | null;
  onInstall: () => void;
  onDismiss: () => void;
};

/** Floating "update available" card, mounted at the app root so it shows in
    every phase (welcome, workspace). Renders nothing while idle. */
export function UpdateBanner({ update, installing, error, onInstall, onDismiss }: Props) {
  if (!update) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-panel/95 p-3 shadow-xl backdrop-blur-sm"
    >
      <div className="flex items-start gap-2.5">
        <span
          className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"
          aria-hidden
        >
          <Download className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">Update available</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            md {update.version} is ready. Restart when the download finishes.
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          disabled={installing}
          className="-mr-1 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onDismiss}
          disabled={installing}
          className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          Not now
        </button>
        <button
          type="button"
          onClick={onInstall}
          disabled={installing}
          className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
        >
          {installing ? "Installing…" : "Restart & update"}
        </button>
      </div>
      {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

export default UpdateBanner;

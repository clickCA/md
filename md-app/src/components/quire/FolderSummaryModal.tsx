import { Check, RefreshCw, Sparkles, Square, TriangleAlert, X } from "lucide-react";
import type { FolderSummaryPhase } from "@/hooks/useFolderSummary";
import { folderLabel } from "@/lib/folder-summary";

type Props = {
  phase: Exclude<FolderSummaryPhase, { kind: "idle" }>;
  providerLabel: string | null;
  onAccept: (content: string) => void;
  onStop: () => void;
  onRegenerate: () => void;
  onDismiss: () => void;
  onClose: () => void;
};

const btn =
  "flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Folder summary preview: the generated markdown is shown, never written.
 * Accept is the only path to disk and it goes through the workspace's normal
 * note write, so git and the search index pick the note up like any other.
 */
export function FolderSummaryModal({
  phase,
  providerLabel,
  onAccept,
  onStop,
  onRegenerate,
  onDismiss,
  onClose,
}: Props) {
  const busy = phase.kind === "running";
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/60 px-4 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={busy ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Summarize ${folderLabel(phase.folder)}`}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-popover shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Sparkles className="size-4 text-primary" aria-hidden />
          <h2 className="flex-1 truncate text-[13px] font-medium">
            Summarize {folderLabel(phase.folder)}
          </h2>
          {providerLabel && (
            <span className="font-mono text-[10px] text-muted-foreground">{providerLabel}</span>
          )}
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        {phase.kind === "running" && (
          <div className="px-3 py-3">
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Sparkles className="size-3.5 animate-pulse text-primary" aria-hidden />
              Reading {phase.scope} note{phase.scope === 1 ? "" : "s"}…
            </p>
            <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-background p-2 font-mono text-[11px] leading-snug text-muted-foreground">
              {phase.streamed || "…"}
            </p>
            <div className="mt-2 flex justify-end">
              <button type="button" className={btn} onClick={onStop}>
                <Square className="size-3" aria-hidden /> Stop
              </button>
            </div>
          </div>
        )}

        {phase.kind === "review" && (
          <>
            <p className="border-b border-border px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
              Accept writes {phase.path} · {phase.scope} note{phase.scope === 1 ? "" : "s"} in scope
            </p>
            <div className="max-h-[55vh] overflow-y-auto whitespace-pre-wrap px-4 py-3 text-[13px] leading-relaxed">
              {phase.content}
            </div>
            <div className="flex justify-end gap-2 border-t border-border p-2">
              <button type="button" className={btn} onClick={onDismiss}>
                <X className="size-3.5" aria-hidden /> Discard
              </button>
              <button type="button" className={btn} onClick={onRegenerate}>
                <RefreshCw className="size-3.5" aria-hidden /> Regenerate
              </button>
              <button
                type="button"
                className={btn}
                onClick={() => onAccept(phase.content)}
                disabled={phase.content.trim() === ""}
              >
                <Check className="size-3.5" aria-hidden /> Accept
              </button>
            </div>
          </>
        )}

        {phase.kind === "error" && (
          <div className="px-3 py-3">
            <p className="flex items-start gap-1.5 text-xs text-destructive">
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-amber-500" aria-hidden />
              {phase.message}
            </p>
            <div className="mt-2 flex justify-end">
              <button type="button" className={btn} onClick={onDismiss}>
                <X className="size-3.5" aria-hidden /> Dismiss
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

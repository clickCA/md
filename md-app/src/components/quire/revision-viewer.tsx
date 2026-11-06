import { useState } from "react";
import { History, RotateCcw, X } from "lucide-react";
import type { HistoryEntry } from "@/types";
import { fileName, relTime } from "@/lib/vault";
import { cn } from "@/lib/utils";

type Props = {
  entry: HistoryEntry;
  /** The revision's content as resolved by the backend (read-only). */
  content: string;
  onRestore: (entry: HistoryEntry) => void;
  onClose: () => void;
};

/** Full-area read-only view of a note revision, opened from the history
    section of the source-control panel. Restoring writes the revision back
    as a normal forward change — it never rewrites history. */
export function RevisionViewer({ entry, content, onRestore, onClose }: Props) {
  const [confirm, setConfirm] = useState(false);
  const deleted = entry.change === "deleted";

  return (
    <section aria-label="Revision" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <History className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="min-w-0 flex-1 truncate font-mono text-[12px]" title={entry.path}>
          {fileName(entry.path)}
          <span className="ml-2 font-sans text-[11px] text-muted-foreground">
            {entry.message.length > 60 ? `${entry.message.slice(0, 60)}…` : entry.message}
          </span>
        </p>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {entry.author} · {relTime(String(entry.time))}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[10px] tracking-wide uppercase",
            deleted
              ? "bg-destructive/15 text-destructive"
              : entry.change === "added"
                ? "bg-added/15 text-added"
                : "bg-modified/15 text-modified",
          )}
        >
          {entry.change}
        </span>
        <button
          type="button"
          onClick={() => {
            if (!confirm) {
              setConfirm(true);
              return;
            }
            setConfirm(false);
            onRestore(entry);
          }}
          title={
            deleted
              ? "write this revision back — recreates the deleted note"
              : "write this revision back as a normal change"
          }
          className={cn(
            "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
            confirm
              ? "bg-destructive text-destructive-foreground"
              : "border border-border text-foreground hover:bg-accent",
          )}
        >
          <RotateCcw className="size-3.5" aria-hidden />
          {confirm ? "Really restore?" : "Restore"}
        </button>
        <button
          type="button"
          aria-label="Close revision"
          title="Close revision"
          onClick={onClose}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      {deleted && (
        <p className="shrink-0 border-b border-border bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          This revision deleted the note — restoring recreates it with its previous content.
        </p>
      )}

      <pre className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-foreground select-text">
        {content}
      </pre>
    </section>
  );
}

import { useEffect, useRef, useState } from "react";
import { FilePlus, Sparkles, Square, X } from "lucide-react";
import type { AiNotePhase } from "@/hooks/useAiNote";

type Props = {
  phase: AiNotePhase;
  providerLabel: string | null;
  onCreate: (description: string) => void;
  onStop: () => void;
  onDismiss: () => void;
  onClose: () => void;
};

/**
 * "Create a note through AI": describe the note, one `ai_text` run composes
 * it, and the result lands as a real note via the normal write path (the
 * note is the preview — edit or delete it like any other).
 */
export function AiNoteModal({ phase, providerLabel, onCreate, onStop, onDismiss, onClose }: Props) {
  const [description, setDescription] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const busy = phase.kind === "running";
  const submit = () => {
    if (!busy && description.trim()) onCreate(description);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/60 px-4 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Create a note with AI"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-popover shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Sparkles className="size-4 text-primary" aria-hidden />
          <h2 className="flex-1 text-[13px] font-medium">Create a note with AI</h2>
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

        <div className="flex flex-col gap-2 px-3 py-3">
          <textarea
            ref={inputRef}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
            }}
            disabled={busy}
            rows={4}
            placeholder="Describe the note — e.g. “meeting notes template for weekly syncs with agenda, decisions and action items”"
            className="w-full resize-none rounded-md border border-input bg-background px-2.5 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:border-primary/60"
          />

          {phase.kind === "running" && (
            <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-[11px] text-muted-foreground">
              <Sparkles className="size-3.5 animate-pulse text-primary" aria-hidden />
              <span className="flex-1 truncate">Writing the note…</span>
              <button
                type="button"
                onClick={onStop}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 hover:bg-accent"
              >
                <Square className="size-3" aria-hidden /> Stop
              </button>
            </div>
          )}

          {phase.kind === "error" && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] leading-snug text-destructive"
            >
              <span className="min-w-0 flex-1">{phase.message}</span>
              <button
                type="button"
                aria-label="Dismiss error"
                onClick={onDismiss}
                className="shrink-0 rounded text-destructive hover:opacity-80"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              The note is written to your vault as a normal file — edit or delete it freely.
            </span>
            <button
              type="button"
              onClick={submit}
              disabled={busy || !description.trim()}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <FilePlus className="size-3.5" aria-hidden /> Create note
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

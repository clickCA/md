import { useEffect, useRef, useState } from "react";
import { Link2, Sparkles, Square, X } from "lucide-react";
import { type Citation, parseCitations, resolveCitations } from "@/lib/ai-ask";
import { fileName } from "@/lib/vault";
import type { AiAskPhase } from "@/hooks/useAiAsk";

type Props = {
  phase: AiAskPhase;
  providerLabel: string | null;
  /** The vault's current notes — citations pointing elsewhere are dropped. */
  files: { path: string }[];
  onAsk: (question: string) => void;
  onStop: () => void;
  onDismiss: () => void;
  onClose: () => void;
  onOpenCitation: (path: string) => void;
};

/**
 * "Ask your notes": retrieval Q&A in a dialog. The answer cites its
 * excerpts inline as [path:line]; citations resolve against the vault and
 * render as clickable chips under the answer.
 */
export function AiAskModal({
  phase,
  providerLabel,
  files,
  onAsk,
  onStop,
  onDismiss,
  onClose,
  onOpenCitation,
}: Props) {
  const [question, setQuestion] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const busy = phase.kind === "running";
  const submit = () => {
    if (!busy && question.trim()) onAsk(question);
  };
  const answer = phase.kind === "answer" ? phase.answer : "";
  const citations = answer ? resolveCitations(parseCitations(answer), files) : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/60 px-4 pt-[max(14vh,env(safe-area-inset-top))] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Ask your notes"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Sparkles className="size-4 text-primary" aria-hidden />
          <h2 className="flex-1 text-[13px] font-medium">Ask your notes</h2>
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

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3">
          <textarea
            ref={inputRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
            }}
            disabled={busy}
            rows={2}
            placeholder="Ask something across your notes — e.g. “what did I decide about the sync model?”"
            className="w-full resize-none rounded-md border border-input bg-background px-2.5 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:border-primary/60"
          />

          {phase.kind === "running" && (
            <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-[11px] text-muted-foreground">
              <Sparkles className="size-3.5 animate-pulse text-primary" aria-hidden />
              <span className="flex-1 truncate">Searching your notes…</span>
              <button
                type="button"
                onClick={onStop}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 hover:bg-accent"
              >
                <Square className="size-3" aria-hidden /> Stop
              </button>
            </div>
          )}

          {phase.kind === "running" && phase.streamed && (
            <pre className="overflow-y-auto rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
              {phase.streamed}
            </pre>
          )}

          {phase.kind === "answer" && (
            <div className="flex min-h-0 flex-col gap-2">
              <pre className="overflow-y-auto rounded-md border border-border bg-background px-2.5 py-2 text-[12px] leading-relaxed whitespace-pre-wrap text-foreground">
                {answer}
              </pre>
              {citations.length > 0 && (
                <div>
                  <span className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                    Sources
                  </span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {citations.map((c: Citation) => (
                      <button
                        key={c.path}
                        type="button"
                        onClick={() => onOpenCitation(c.path)}
                        title={c.line ? `${c.path}:${c.line}` : c.path}
                        className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-foreground hover:bg-accent"
                      >
                        <Link2 className="size-3 text-primary" aria-hidden />
                        {fileName(c.path)}
                        {c.line !== null && (
                          <span className="font-mono text-[10px] text-muted-foreground">
                            :{c.line}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
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
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2.5">
          <span className="text-[11px] text-muted-foreground">
            Answers come only from your own notes, with citations.
          </span>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !question.trim()}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Ask
          </button>
        </div>
      </div>
    </div>
  );
}

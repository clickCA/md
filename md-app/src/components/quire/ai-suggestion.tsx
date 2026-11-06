import { Check, RefreshCw, Sparkles, Square, TriangleAlert, X } from "lucide-react";
import { AI_ACTIONS, suggestionDiff } from "@/lib/ai-selection";
import type { AiRequest } from "@/lib/ai-selection";
import { diffStat, hunkHeader } from "@/lib/diff";

/**
 * What the editor's floating AI layer can be doing. `idle` renders nothing.
 * The card is presentation-only: every transition is decided by the editor,
 * which owns the CodeMirror view and the version guard.
 */
export type AiPhase =
  | { kind: "idle" }
  /** No usable AI provider — `hint` says what to install / what failed. */
  | { kind: "unavailable"; hint: string; anchor: { x: number; y: number } }
  | {
      kind: "generating";
      req: AiRequest;
      streamed: string;
      anchor: { x: number; y: number };
    }
  | {
      kind: "review";
      req: AiRequest;
      suggestion: string;
      /** The document changed since the request — Accept is refused. */
      stale: boolean;
      anchor: { x: number; y: number };
    };

export type AiPhaseActive = Exclude<AiPhase, { kind: "idle" }>;

type Props = {
  phase: AiPhaseActive;
  onAccept: () => void;
  onReject: () => void;
  onRegenerate: () => void;
  onCancel: () => void;
};

const btn =
  "flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40";

/** The floating AI layer: anchor-positioned by the editor. */
export function AiSuggestionCard({ phase, onAccept, onReject, onRegenerate, onCancel }: Props) {
  if (phase.kind === "unavailable") {
    return (
      <div className="max-w-[30rem] rounded-lg border border-border bg-[var(--panel)] p-3 text-xs shadow-lg">
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <TriangleAlert className="size-3.5 text-amber-500" aria-hidden />
          {phase.hint}
        </p>
        <div className="mt-2 flex justify-end">
          <button type="button" className={btn} onClick={onReject}>
            <X className="size-3.5" aria-hidden /> Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (phase.kind === "generating") {
    const running = AI_ACTIONS.find((a) => a.label === phase.req.label)?.running ?? "Working…";
    return (
      <div className="max-w-[30rem] rounded-lg border border-border bg-[var(--panel)] p-3 text-xs shadow-lg">
        <p className="flex items-center gap-1.5 font-medium">
          <Sparkles className="size-3.5 animate-pulse text-primary" aria-hidden />
          {running}
        </p>
        {phase.streamed && (
          <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-muted-foreground">
            {phase.streamed}
          </p>
        )}
        <div className="mt-2 flex justify-end">
          <button type="button" className={btn} onClick={onCancel}>
            <Square className="size-3" aria-hidden /> Stop
          </button>
        </div>
      </div>
    );
  }

  const { req, suggestion, stale } = phase;
  const hunks = suggestionDiff(req.original, suggestion);
  const stat = diffStat(hunks);

  return (
    <div className="max-w-[32rem] rounded-lg border border-border bg-[var(--panel)] text-xs shadow-lg">
      <div className="flex h-9 items-center gap-1.5 border-b border-border px-3">
        <Sparkles className="size-3.5 shrink-0 text-primary" aria-hidden />
        <p className="min-w-0 flex-1 truncate font-medium">AI suggestion · {req.label}</p>
        {(stat.additions > 0 || stat.deletions > 0) && (
          <span className="shrink-0 font-mono text-[11px]" aria-label="diff stat">
            <span className="text-added">+{stat.additions}</span>{" "}
            <span className="text-destructive">-{stat.deletions}</span>
          </span>
        )}
        <button
          type="button"
          aria-label="Reject suggestion"
          onClick={onReject}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      {stale && (
        <p className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-amber-600 dark:text-amber-400">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          The note changed while the AI was running — apply is refused. Discard or regenerate
          against the current text.
        </p>
      )}
      <div className="max-h-56 overflow-y-auto p-2 font-mono text-[11px] leading-snug">
        {hunks.map((h) => (
          <div key={hunkHeader(h)}>
            <p className="select-none text-muted-foreground">{hunkHeader(h)}</p>
            {h.rows.map((r, i) => (
              <p
                key={i}
                className={
                  r.type === "add"
                    ? "bg-added/15 text-added"
                    : r.type === "del"
                      ? "bg-destructive/10 text-destructive"
                      : "text-muted-foreground"
                }
              >
                {r.type === "add" ? "+ " : r.type === "del" ? "- " : "  "}
                {r.text || " "}
              </p>
            ))}
          </div>
        ))}
        {hunks.length === 0 && (
          <p className="p-1 text-muted-foreground">The suggestion matches the original text.</p>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-border p-2">
        <button type="button" className={btn} onClick={onReject}>
          <X className="size-3.5" aria-hidden /> Discard
        </button>
        <button type="button" className={btn} onClick={onRegenerate}>
          <RefreshCw className="size-3.5" aria-hidden /> Regenerate
        </button>
        <button type="button" className={btn} onClick={onAccept} disabled={stale}>
          <Check className="size-3.5" aria-hidden /> Accept
        </button>
      </div>
    </div>
  );
}

import { useMemo } from "react";
import { Check, FileDiff, RefreshCw, Sparkles, Square, X } from "lucide-react";
import { INLINE_AI_LABEL, type InlineAiOp } from "@/lib/inline-ai";
import { type DiffRow, diffLines, diffStat, hunkHeader } from "@/lib/diff";
import { cn } from "@/lib/utils";
import type { InlineAiPhase } from "@/hooks/useInlineAi";

type Props = {
  phase: InlineAiPhase;
  /** The proposal's captured version no longer matches the document. */
  stale: boolean;
  providerLabel: string | null;
  hasSelection: boolean;
  onRun: (op: InlineAiOp) => void;
  onAccept: () => void;
  onReject: () => void;
  onRegenerate: () => void;
  onStop: () => void;
  onDismiss: () => void;
};

const OPS: InlineAiOp[] = ["rewrite", "grammar", "continue", "summarize"];

/**
 * The inline AI surface (docs/adr/2026-11-06-inline-ai-surface.md), anchored
 * to the editor pane. Chips appear for a selection; a run streams here; the
 * candidate previews as a diff against the selection and is applied only on
 * Accept — Reject and a stale proposal leave the working tree untouched.
 */
export function InlineAiPanel({
  phase,
  stale,
  providerLabel,
  hasSelection,
  onRun,
  onAccept,
  onReject,
  onRegenerate,
  onStop,
  onDismiss,
}: Props) {
  if (phase.kind === "idle" && !hasSelection) return null;

  return (
    <div
      aria-label="Inline AI"
      className="absolute right-6 bottom-12 z-20 w-96 max-w-[90%] overflow-hidden rounded-lg border border-border bg-panel/95 shadow-lg backdrop-blur-sm"
    >
      {phase.kind === "idle" && (
        <div className="flex items-center gap-1 px-2.5 py-2">
          <Sparkles className="mr-1 size-3.5 shrink-0 text-primary" aria-hidden />
          {OPS.map((op) => (
            <button
              key={op}
              type="button"
              onClick={() => onRun(op)}
              className="flex h-6 items-center rounded-md border border-border px-2 text-[11px] text-foreground hover:bg-accent"
              title={`${INLINE_AI_LABEL[op]} the selection with ${providerLabel ?? "an installed AI CLI"}`}
            >
              {INLINE_AI_LABEL[op]}
            </button>
          ))}
          {providerLabel && (
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              {providerLabel}
            </span>
          )}
        </div>
      )}

      {phase.kind === "running" && (
        <div className="flex flex-col gap-2 px-2.5 py-2">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Sparkles className="size-3.5 animate-pulse text-primary" aria-hidden />
            <span>
              {INLINE_AI_LABEL[phase.op]}… <span className="font-mono">{providerLabel}</span>
            </span>
            <button
              type="button"
              onClick={onStop}
              className="ml-auto flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] hover:bg-accent"
              title="stop the request"
            >
              <Square className="size-3" aria-hidden /> Stop
            </button>
          </div>
          {phase.streamed && (
            <pre className="max-h-32 overflow-y-auto rounded-md border border-border px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
              {phase.streamed}
            </pre>
          )}
        </div>
      )}

      {phase.kind === "preview" && (
        <div className="flex flex-col gap-2 px-2.5 py-2">
          <div className="flex items-center gap-1.5 text-[11px]">
            <FileDiff className="size-3.5 text-muted-foreground" aria-hidden />
            <span className="font-medium text-foreground">{INLINE_AI_LABEL[phase.op]}</span>
            <span className="font-mono text-muted-foreground">{providerLabel}</span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={onReject}
              aria-label="Reject proposal"
              title="discard the proposal"
              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>

          {stale ? (
            <div
              role="status"
              className="rounded-md border border-modified/40 bg-modified/10 px-2 py-1.5 text-[11px] leading-snug text-modified"
            >
              The note changed while the assistant was working — this proposal no longer matches the
              selection. Regenerate or discard it; it cannot be applied.
            </div>
          ) : (
            <CandidateDiff selectionText={phase.selectionText} candidate={phase.candidate} />
          )}

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onAccept}
              disabled={stale}
              className="flex h-6 flex-1 items-center justify-center gap-1 rounded-md bg-primary text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
              title="replace the selection with the proposal"
            >
              <Check className="size-3.5" aria-hidden /> Accept
            </button>
            <button
              type="button"
              onClick={onRegenerate}
              className="flex h-6 items-center justify-center gap-1 rounded-md border border-border px-2 text-[11px] hover:bg-accent"
              title="run the operation again on the current selection"
            >
              <RefreshCw className="size-3" aria-hidden /> Regenerate
            </button>
          </div>
        </div>
      )}

      {phase.kind === "error" && (
        <div className="flex items-start gap-2 px-2.5 py-2">
          <div
            role="alert"
            className="min-w-0 flex-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] leading-snug text-destructive"
          >
            {phase.message}
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss error"
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}

/** Compact winner-vs-candidate preview: − lines are the current selection,
    + lines what Accept would put in its place. */
function CandidateDiff({ selectionText, candidate }: { selectionText: string; candidate: string }) {
  const hunks = useMemo(() => diffLines(selectionText, candidate), [selectionText, candidate]);
  const stat = useMemo(() => diffStat(hunks), [hunks]);

  if (hunks.length === 0) {
    return (
      <p className="rounded-md border border-border bg-background px-2 py-1.5 text-[11px] text-muted-foreground">
        The candidate is identical to the selection.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-[10px] text-muted-foreground">
        <span>
          <span className="text-destructive">−</span> selection
          <span className="px-1">·</span>
          <span className="text-added">+</span> proposal
        </span>
        <span
          className="font-mono"
          aria-label={`${stat.additions} additions, ${stat.deletions} deletions`}
        >
          <span className="text-added">+{stat.additions}</span>{" "}
          <span className="text-destructive">−{stat.deletions}</span>
        </span>
      </div>
      <div className="max-h-48 overflow-y-auto py-1 font-mono text-[11px] leading-5">
        {hunks.map((h, hi) => (
          <div key={hi}>
            <div className="bg-panel px-3 py-0.5 text-[10px] text-muted-foreground select-none">
              {hunkHeader(h)}
            </div>
            {h.rows.map((r, ri) => (
              <Row key={ri} row={r} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function Row({ row }: { row: DiffRow }) {
  const added = row.type === "add";
  const removed = row.type === "del";
  return (
    <div className={cn("flex", added && "bg-added/10", removed && "bg-destructive/10")}>
      <span
        className={cn(
          "w-4 shrink-0 text-center select-none",
          added && "text-added",
          removed && "text-destructive",
        )}
        aria-hidden
      >
        {added ? "+" : removed ? "-" : " "}
      </span>
      <span className="min-w-0 flex-1 pr-3 whitespace-pre-wrap break-words">{row.text || " "}</span>
    </div>
  );
}

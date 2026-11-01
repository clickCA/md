import { useMemo } from "react";
import { FileDiff, PenLine, X } from "lucide-react";
import type { VaultFile } from "@/lib/vault";
import { type DiffRow, diffLines, diffStat, hunkHeader } from "@/lib/diff";
import { cn } from "@/lib/utils";

type Props = {
  /** Note being inspected; `committed` is diffed against `content`. */
  file: VaultFile;
  onOpenNote: (path: string) => void;
  onClose: () => void;
};

/** Full-area view of a note's uncommitted changes, opened from the
    source-control panel. Untracked notes diff against an empty file. */
export function DiffViewer({ file, onOpenNote, onClose }: Props) {
  const isNew = file.committed === null;
  const hunks = useMemo(
    () => diffLines(file.committed ?? "", file.content),
    [file.committed, file.content],
  );
  const stat = useMemo(() => diffStat(hunks), [hunks]);

  return (
    <section aria-label="Diff" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <FileDiff className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="min-w-0 flex-1 truncate font-mono text-[12px]" title={file.path}>
          {file.path}
        </p>
        {isNew && (
          <span className="shrink-0 rounded-sm bg-added/15 px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-added uppercase">
            new file
          </span>
        )}
        {(stat.additions > 0 || stat.deletions > 0) && (
          <span
            className="shrink-0 font-mono text-[11px]"
            aria-label={`${stat.additions} additions, ${stat.deletions} deletions`}
          >
            <span className="text-added">+{stat.additions}</span>{" "}
            <span className="text-destructive">-{stat.deletions}</span>
          </span>
        )}
        <button
          type="button"
          onClick={() => onOpenNote(file.path)}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-foreground hover:bg-accent"
          title="open this note in the editor"
        >
          <PenLine className="size-3.5" aria-hidden />
          Edit note
        </button>
        <button
          type="button"
          aria-label="Close diff"
          title="Close diff"
          onClick={onClose}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {hunks.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No changes against the last commit.
          </p>
        ) : (
          <div className="py-2 font-mono text-[12px] leading-5">
            {hunks.map((h, hi) => (
              <div key={hi}>
                <div className="bg-panel px-3 py-0.5 text-[11px] text-muted-foreground select-none">
                  {hunkHeader(h)}
                </div>
                {h.rows.map((r, ri) => (
                  <Row key={ri} row={r} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Row({ row }: { row: DiffRow }) {
  const added = row.type === "add";
  const removed = row.type === "del";
  return (
    <div className={cn("flex", added && "bg-added/10", removed && "bg-destructive/10")}>
      <span className="w-10 shrink-0 px-2 text-right text-muted-foreground/70 select-none tabular-nums">
        {row.oldNo ?? ""}
      </span>
      <span className="w-10 shrink-0 px-2 text-right text-muted-foreground/70 select-none tabular-nums">
        {row.newNo ?? ""}
      </span>
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
      <span className="min-w-0 flex-1 pr-4 whitespace-pre-wrap break-words">{row.text || " "}</span>
    </div>
  );
}

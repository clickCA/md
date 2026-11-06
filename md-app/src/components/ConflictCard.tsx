import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, ArrowRight, FileDiff, Trash2, Undo2 } from "lucide-react";
import { type DiffRow, diffLines, diffStat, hunkHeader } from "@/lib/diff";
import { errorMessage } from "@/lib/ipc";
import { cn } from "@/lib/utils";

interface Conflict {
  path: string;
  conflictCopy: string;
  winner: string;
}

interface Props {
  dir: string;
  conflicts: Conflict[];
  busy: boolean;
  onResolved: () => void;
}

export default function ConflictCard({ dir, conflicts, busy, onResolved }: Props) {
  // Which conflict's diff is open, and the two sides once loaded.
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [sides, setSides] = useState<{ winner: string; copy: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (conflicts.length === 0) return null;

  const closeDiff = () => {
    setDiffPath(null);
    setSides(null);
  };

  const keepWinner = async (conflict: Conflict) => {
    await invoke("note_delete", { dir, path: conflict.conflictCopy });
    closeDiff();
    onResolved();
  };

  const restoreCopy = async (conflict: Conflict) => {
    const content = await invoke<string>("note_read", { dir, path: conflict.conflictCopy });
    await invoke("note_write", { dir, path: conflict.path, content });
    await invoke("note_delete", { dir, path: conflict.conflictCopy });
    closeDiff();
    onResolved();
  };

  const toggleDiff = async (conflict: Conflict) => {
    if (diffPath === conflict.conflictCopy) {
      closeDiff();
      return;
    }
    setError(null);
    try {
      const [winner, copy] = await Promise.all([
        invoke<string>("note_read", { dir, path: conflict.path }),
        invoke<string>("note_read", { dir, path: conflict.conflictCopy }),
      ]);
      setSides({ winner, copy });
      setDiffPath(conflict.conflictCopy);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="border-b border-border bg-destructive/5 px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-destructive">
        <AlertTriangle size={13} />
        {conflicts.length} conflict{conflicts.length > 1 ? "s" : ""} — the sync kept the last
        writer's version; the other copy was preserved
      </div>
      {error && (
        <p role="alert" className="mb-2 text-[11px] text-destructive">
          {error}
        </p>
      )}
      <ul className="space-y-2">
        {conflicts.map((c) => (
          <li
            key={c.conflictCopy}
            className="rounded-md border border-border bg-popover px-3 py-2 text-xs"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{c.path}</span>
              <ArrowRight size={12} className="text-muted-foreground" />
              <span className="font-mono text-muted-foreground">{c.conflictCopy}</span>
              <span className="text-muted-foreground">(winner: {c.winner})</span>
              <div className="flex-1" />
              <button
                onClick={() => void toggleDiff(c)}
                aria-expanded={diffPath === c.conflictCopy}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 hover:bg-accent disabled:opacity-40"
                title="compare the version the sync kept with the preserved copy"
              >
                <FileDiff size={12} />
                {diffPath === c.conflictCopy ? "hide diff" : "view diff"}
              </button>
              <button
                onClick={() => void keepWinner(c)}
                disabled={busy}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 hover:bg-accent disabled:opacity-40"
                title="delete the conflict copy, keep the winner"
              >
                <Trash2 size={12} /> keep winner
              </button>
              <button
                onClick={() => void restoreCopy(c)}
                disabled={busy}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 hover:bg-accent disabled:opacity-40"
                title="restore the preserved copy over the winner"
              >
                <Undo2 size={12} /> restore copy
              </button>
            </div>
            {diffPath === c.conflictCopy && sides && (
              <ConflictDiff winner={sides.winner} copy={sides.copy} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Compact winner-vs-copy preview: the kept version is the old side, the
    preserved conflict copy the new side — same direction as "restore copy",
    which would apply exactly these + lines. */
function ConflictDiff({ winner, copy }: { winner: string; copy: string }) {
  const hunks = useMemo(() => diffLines(winner, copy), [winner, copy]);
  const stat = useMemo(() => diffStat(hunks), [hunks]);

  if (hunks.length === 0) {
    return (
      <p className="mt-2 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground">
        The two versions have identical text.
      </p>
    );
  }

  return (
    <div className="mt-2 overflow-x-auto rounded-md border border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-[10px] text-muted-foreground">
        <span>
          <span className="text-destructive">−</span> kept winner
          <span className="px-1">·</span>
          <span className="text-added">+</span> conflict copy
        </span>
        <span
          className="font-mono"
          aria-label={`${stat.additions} additions, ${stat.deletions} deletions`}
        >
          <span className="text-added">+{stat.additions}</span>{" "}
          <span className="text-destructive">−{stat.deletions}</span>
        </span>
      </div>
      <div className="py-1 font-mono text-[11px] leading-5">
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

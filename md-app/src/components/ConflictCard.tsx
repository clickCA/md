import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, ArrowRight, Trash2, Undo2 } from "lucide-react";

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
  if (conflicts.length === 0) return null;

  const keepWinner = async (conflict: Conflict) => {
    await invoke("note_delete", { dir, path: conflict.conflictCopy });
    onResolved();
  };

  const restoreCopy = async (conflict: Conflict) => {
    const content = await invoke<string>("note_read", { dir, path: conflict.conflictCopy });
    await invoke("note_write", { dir, path: conflict.path, content });
    await invoke("note_delete", { dir, path: conflict.conflictCopy });
    onResolved();
  };

  return (
    <div className="border-b border-border bg-destructive/5 px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-destructive">
        <AlertTriangle size={13} />
        {conflicts.length} conflict{conflicts.length > 1 ? "s" : ""} — the sync kept the last
        writer's version; the other copy was preserved
      </div>
      <ul className="space-y-2">
        {conflicts.map((c) => (
          <li
            key={c.conflictCopy}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-popover px-3 py-2 text-xs"
          >
            <span className="font-mono">{c.path}</span>
            <ArrowRight size={12} className="text-muted-foreground" />
            <span className="font-mono text-muted-foreground">{c.conflictCopy}</span>
            <span className="text-muted-foreground">(winner: {c.winner})</span>
            <div className="flex-1" />
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
          </li>
        ))}
      </ul>
    </div>
  );
}

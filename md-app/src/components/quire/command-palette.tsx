import { useState } from "react";
import { Command as CommandIcon, FileText, Search } from "lucide-react";
import { type VaultFile, fileName } from "@/lib/vault";
import { cn } from "@/lib/utils";

export type PaletteCommand = { id: string; label: string; hint?: string; run: () => void };

type Props = {
  files: VaultFile[];
  commands: PaletteCommand[];
  onOpenFile: (path: string) => void;
  onClose: () => void;
};

export function CommandPalette({ files, commands, onOpenFile, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const q = query.trim().toLowerCase();

  const items = [
    ...files
      .filter((f) => f.path.toLowerCase().includes(q))
      .map((f) => ({
        id: f.path,
        label: fileName(f.path),
        hint: f.path,
        kind: "file" as const,
        run: () => onOpenFile(f.path),
      })),
    ...commands.filter((c) => c.label.toLowerCase().includes(q)).map((c) => ({ ...c, kind: "command" as const })),
  ];

  const select = (i: number) => {
    items[i]?.run();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/60 px-4 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-popover shadow-2xl"
      >
        <label className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 text-muted-foreground" aria-hidden />
          <span className="sr-only">Search notes and commands</span>
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, items.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              }
              if (e.key === "Enter") {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                select(index);
              }
            }}
            placeholder="Jump to a note or run a command"
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>
        <ul role="listbox" aria-label="Results" className="max-h-80 overflow-y-auto p-1.5">
          {items.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches.</li>
          )}
          {items.map((item, i) => (
            <li key={item.id} role="option" aria-selected={i === index}>
              <button
                type="button"
                onMouseEnter={() => setIndex(i)}
                onClick={() => select(i)}
                className={cn(
                  "flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm",
                  i === index && "bg-accent",
                )}
              >
                {item.kind === "file" ? (
                  <FileText className="size-4 text-muted-foreground" aria-hidden />
                ) : (
                  <CommandIcon className="size-4 text-primary" aria-hidden />
                )}
                <span className="truncate">{item.label}</span>
                {item.hint && (
                  <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">{item.hint}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

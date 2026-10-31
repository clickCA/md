import { Hash, Link2 } from "lucide-react";
import { type VaultFile, backlinks, fileName, headings } from "@/lib/vault";
import { cn } from "@/lib/utils";
import { PanelHeader } from "./panel-header";

type Props = {
  file: VaultFile;
  files: VaultFile[];
  onOpen: (path: string) => void;
  onJump: (line: number) => void;
};

export function Inspector({ file, files, onOpen, onJump }: Props) {
  const outline = headings(file.content);
  const links = backlinks(files, file.path);
  const words = file.content.trim().split(/\s+/).filter(Boolean).length;

  return (
    <aside
      aria-label="Note details"
      className="hidden w-60 shrink-0 flex-col overflow-y-auto pt-8 lg:flex"
    >
      <PanelHeader title="Outline" />
      <ul className="px-1.5">
        {outline.map((h) => (
          <li key={h.line}>
            <button
              type="button"
              onClick={() => onJump(h.line)}
              style={{ paddingLeft: `${(h.level - 1) * 12 + 8}px` }}
              className={cn(
                "flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[13px] hover:bg-sidebar-accent",
                h.level === 1 ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Hash className="size-3 shrink-0 opacity-50" aria-hidden />
              <span className="truncate">{h.text}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-4">
        <PanelHeader title={`Backlinks ${links.length}`} />
        {links.length === 0 ? (
          <p className="px-3 text-xs leading-relaxed text-muted-foreground">
            No notes link here yet.
          </p>
        ) : (
          <ul className="px-1.5">
            {links.map((f) => {
              const snippet = f.content
                .split("\n")
                .find((l) => l.includes(`[[${fileName(file.path)}]]`))
                ?.trim();
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    onClick={() => onOpen(f.path)}
                    className="w-full rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent"
                  >
                    <span className="flex items-center gap-1.5 text-[13px]">
                      <Link2 className="size-3 text-primary" aria-hidden />
                      {fileName(f.path)}
                    </span>
                    {snippet && (
                      <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-muted-foreground">
                        {snippet}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <dl className="mt-auto grid grid-cols-2 gap-y-1 border-t border-border px-3 py-3 text-xs">
        <dt className="text-muted-foreground">Words</dt>
        <dd className="text-right font-mono">{words}</dd>
        <dt className="text-muted-foreground">Reading</dt>
        <dd className="text-right font-mono">{Math.max(1, Math.round(words / 230))} min</dd>
        <dt className="text-muted-foreground">Path</dt>
        <dd className="truncate text-right font-mono" title={file.path}>
          {file.path}
        </dd>
      </dl>
    </aside>
  );
}

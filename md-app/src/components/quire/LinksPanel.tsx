import { RefreshCw } from "lucide-react";
import type { BrokenLink } from "@/types";
import { fileName } from "@/lib/vault";
import { cn } from "@/lib/utils";
import { PanelHeader } from "./PanelHeader";

type Props = {
  /** null = not scanned yet; [] = scanned, everything resolves. */
  report: BrokenLink[] | null;
  loading: boolean;
  onRescan: () => void;
  /** Open the source note at the broken reference. */
  onOpenLink: (source: string, line: number) => void;
};

/** Broken internal link report: every unresolved [[wikilink]] and relative
    Markdown link, with its source note and line. Excluded notes are never
    sources or targets — the engine scans the visible note set only. */
export function LinksPanel({ report, loading, onRescan, onOpenLink }: Props) {
  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Links">
        <button
          type="button"
          onClick={onRescan}
          disabled={loading}
          aria-label="Rescan links"
          title="Rescan the vault for broken links"
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden />
        </button>
      </PanelHeader>

      <div className="flex-1 overflow-y-auto px-1.5 pb-4">
        {report === null && (
          <p className="px-2 py-4 text-[13px] leading-relaxed text-muted-foreground">
            Scan the vault for unresolved <span className="font-mono">[[wikilinks]]</span> and
            relative Markdown links. Excluded notes are never scanned or counted as targets.
          </p>
        )}
        {report !== null && report.length === 0 && !loading && (
          <p className="px-2 py-4 text-[13px] text-muted-foreground">
            All links resolve — no broken references.
          </p>
        )}
        <ul>
          {(report ?? []).map((l) => (
            <li key={`${l.source}-${l.line}-${l.target}`}>
              <button
                type="button"
                onClick={() => onOpenLink(l.source, l.line)}
                title={`Open ${l.source} at line ${l.line}`}
                className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent"
              >
                <span className="flex items-baseline gap-2">
                  <span
                    className={cn(
                      "shrink-0 rounded-sm px-1 font-mono text-[9px] tracking-wide uppercase",
                      l.kind === "wiki" ? "bg-modified/15 text-modified" : "bg-added/15 text-added",
                    )}
                  >
                    {l.kind}
                  </span>
                  <span className="min-w-0 truncate text-[13px] leading-5 text-destructive">
                    {l.target}
                  </span>
                </span>
                <span className="flex items-baseline gap-2 pl-0.5">
                  <span className="min-w-0 truncate text-[11px] leading-4 text-muted-foreground">
                    {fileName(l.source)}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] leading-4 text-muted-foreground">
                    L{l.line}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

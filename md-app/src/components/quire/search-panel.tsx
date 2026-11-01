import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import type { SearchHit } from "@/hooks/useVault";
import { fileName } from "@/lib/vault";
import { PanelHeader } from "./panel-header";

type Props = {
  onOpen: (path: string) => void;
  search: (query: string) => Promise<SearchHit[]>;
};

export function SearchPanel({ onOpen, search }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const q = query.trim();

  useEffect(() => {
    if (!q) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      void search(q)
        .then((r) => {
          if (!cancelled) setHits(r);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, search]);

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Search" />
      <div className="px-3 pb-2">
        <label className="flex h-7 items-center gap-2 rounded-md border border-input bg-background px-2 focus-within:border-primary/60">
          <Search className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="sr-only">Search vault</span>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search vault"
            className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>
      <div className="flex-1 overflow-y-auto px-1.5 pb-4">
        {q && !loading && hits.length === 0 && (
          <p className="px-2 py-4 text-[13px] text-muted-foreground">No matches.</p>
        )}
        {!q && (
          <p className="px-2 py-2 text-[13px] leading-relaxed text-muted-foreground">
            Full-text search runs locally against your markdown files.
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {hits.map((hit) => (
            <li key={hit.path}>
              <button
                type="button"
                onClick={() => onOpen(hit.path)}
                className="w-full rounded-md px-2 py-1 text-left text-[13px] font-medium hover:bg-sidebar-accent"
              >
                {fileName(hit.path)}
              </button>
              <ul>
                {hit.matches.map(({ snippet, line }) => (
                  <li key={line}>
                    <button
                      type="button"
                      onClick={() => onOpen(hit.path)}
                      className="flex w-full gap-2 rounded-md px-2 py-0.5 text-left text-xs text-muted-foreground hover:bg-sidebar-accent"
                    >
                      <span className="w-5 shrink-0 text-right font-mono text-[10px] leading-5">
                        {line}
                      </span>
                      <span className="min-w-0 flex-1 truncate leading-5">
                        <Highlight text={snippet} query={q.toLowerCase()} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  const index = text.toLowerCase().indexOf(query);
  if (index === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-sm bg-primary/25 text-foreground">
        {text.slice(index, index + query.length)}
      </mark>
      {text.slice(index + query.length)}
    </>
  );
}

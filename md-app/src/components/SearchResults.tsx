import { type ReactNode } from "react";
import { FileText } from "lucide-react";

export interface SearchMatch {
  line: number;
  snippet: string;
}

export interface SearchHit {
  path: string;
  matches: SearchMatch[];
}

/** Highlight every (case-insensitive) occurrence of the query terms in text. */
function highlight(text: string, terms: string[]): ReactNode[] {
  if (terms.length === 0) return [text];
  const escaped = terms
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const re = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(re);
  return parts.map((part, i) =>
    terms.some((t) => part.toLowerCase() === t.toLowerCase()) ? (
      <mark key={i} className="rounded bg-accent/25 text-text">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

interface Props {
  query: string;
  results: SearchHit[];
  activeNote: string | null;
  onPick: (path: string) => void;
}

export default function SearchResults({ query, results, activeNote, onPick }: Props) {
  const terms = query.trim().split(/\s+/);
  const totalMatches = results.reduce((n, r) => n + r.matches.length, 0);

  if (results.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-text-2">
        no matches for “{query}”
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-3 py-1.5 text-xs text-text-2">
        {results.length} note{results.length > 1 ? "s" : ""} · {totalMatches} match
        {totalMatches > 1 ? "es" : ""}
      </div>
      {results.map((hit) => (
        <div key={hit.path} className="mb-1">
          <button
            onClick={() => onPick(hit.path)}
            className={
              "flex w-full items-center gap-1.5 px-3 py-1 text-left text-sm hover:bg-surface-2 " +
              (hit.path === activeNote ? "font-medium text-accent" : "")
            }
          >
            <FileText size={13} className="shrink-0 text-text-2" />
            <span className="truncate" title={hit.path}>
              {hit.path.split("/").pop()}
            </span>
            <span className="truncate text-xs text-text-2">
              {hit.path.includes("/") && hit.path}
            </span>
          </button>
          <ul>
            {hit.matches.map((m) => (
              <li key={m.line}>
                <button
                  onClick={() => onPick(hit.path)}
                  className="block w-full truncate px-3 py-0.5 pl-8 text-left text-xs text-text-2 hover:bg-surface-2"
                  title={`line ${m.line}`}
                >
                  <span className="mr-1.5 tabular-nums opacity-60">{m.line}</span>
                  {highlight(m.snippet, terms)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

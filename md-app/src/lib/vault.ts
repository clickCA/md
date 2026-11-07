import { invoke } from "@tauri-apps/api/core";

export const DEFAULT_DIR = "/tmp/md-vault";

/** Platform-appropriate vault location (app-sandboxed on mobile). */
export async function resolveDefaultDir(): Promise<string> {
  try {
    const d = await invoke<string>("default_vault_dir");
    if (d) return d;
  } catch {
    // fall back to the desktop demo default
  }
  return DEFAULT_DIR;
}

export function short(oid: string | null): string {
  return oid ? oid.slice(0, 7) : "—";
}

/** Suggested vault name from a git URL (`owner/repo.git` → `owner-repo`).
    Mirrors the Rust `slug_from_url` shape for the clone dialog placeholder;
    the backend still sanitizes whatever the user actually submits. */
export function remoteName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const segs = trimmed.split("/").filter(Boolean);
  const last = (segs.pop() ?? "").replace(/\.git$/, "");
  if (!last) return "";
  const owner = segs[segs.length - 1];
  return owner ? `${owner}-${last}` : last;
}

/** Filesystem-safe vault name for the mobile create flow. `vault_make` takes
    a raw path (by design, for the desktop folder picker), so the mobile UI
    sanitizes the user-typed name before joining it under the vaults home —
    mirrors the backend `safe_name` so both entry points behave identically. */
export function sanitizeVaultName(raw: string): string {
  const s = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  return s || "vault";
}

/** Human "time ago" from an epoch-seconds string (as stored in the sync journal). */
export function relTime(secs: string | null | undefined, now = Date.now()): string {
  if (!secs) return "never";
  const t = Number(secs);
  if (!Number.isFinite(t)) return secs;
  const diff = Math.max(0, Math.floor(now / 1000 - t));
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Journal event states ("fetching", "merging") as a display label. */
export function eventLabel(state: string): string {
  return state ? state.charAt(0).toUpperCase() + state.slice(1) : state;
}

/* ── vault model (ported from the Quire UI) ─────────────────────────── */

export type VaultFile = {
  path: string;
  content: string;
  /** committed content, or null when the note is untracked */
  committed: string | null;
};

export type GitStatus = "modified" | "untracked" | "clean";

/** "edit" = inline live preview; "preview" = fully rendered reading view */
export type ViewMode = "edit" | "preview";

export type SidePanel = "files" | "search" | "ask" | "links" | "git";

export function fileName(path: string) {
  return path.split("/").pop()!.replace(/\.md$/, "");
}

export function wordCount(text: string) {
  return (text.match(/\p{L}[\p{L}\p{N}'’-]*/gu) ?? []).length;
}

export function parentOf(path: string) {
  return path.split("/").slice(0, -1).join("/");
}

export function statusOf(file: VaultFile): GitStatus {
  if (file.committed === null) return "untracked";
  return file.content === file.committed ? "clean" : "modified";
}

export type LineChange = "added" | "modified" | null;

export function lineChanges(file: VaultFile): LineChange[] {
  const lines = file.content.split("\n");
  if (file.committed === null) return lines.map(() => "added");
  const original = file.committed.split("\n");
  const originalSet = new Set(original);
  return lines.map((line, i) => {
    if (line === original[i] || originalSet.has(line)) return null;
    return i < original.length ? "modified" : "added";
  });
}

export type TreeNode =
  | { type: "folder"; name: string; path: string; children: TreeNode[] }
  | { type: "file"; name: string; path: string };

export function buildTree(files: VaultFile[], folders: string[] = []): TreeNode[] {
  const root: TreeNode[] = [];
  const descend = (parts: string[], count: number) => {
    let level = root;
    for (let i = 0; i < count; i++) {
      const part = parts[i];
      let folder = level.find((n) => n.type === "folder" && n.name === part);
      if (!folder) {
        folder = {
          type: "folder",
          name: part,
          path: parts.slice(0, i + 1).join("/"),
          children: [],
        };
        level.push(folder);
      }
      level = (folder as Extract<TreeNode, { type: "folder" }>).children;
    }
    return level;
  };
  for (const folder of folders) {
    const parts = folder.split("/");
    descend(parts, parts.length);
  }
  for (const file of files) {
    const parts = file.path.split("/");
    descend(parts, parts.length - 1).push({
      type: "file",
      name: parts.at(-1)!.replace(/\.md$/, ""),
      path: file.path,
    });
  }
  const sort = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1,
      )
      .map((n) => (n.type === "folder" ? { ...n, children: sort(n.children) } : n));
  return sort(root);
}

export function headings(content: string) {
  return content
    .split("\n")
    .map((line, index) => {
      const match = /^(#{1,3})\s+(.*)/.exec(line);
      return match ? { level: match[1].length, text: match[2], line: index } : null;
    })
    .filter((h): h is { level: number; text: string; line: number } => h !== null);
}

export function backlinks(files: VaultFile[], target: string) {
  const needle = `[[${fileName(target)}]]`;
  return files.filter((f) => f.path !== target && f.content.includes(needle));
}

/* ── Related notes ─────────────────────────────────────────────────────
   Syntactic suggestion ("related notes" in the product plan), deliberately
   not semantic: shared wikilink targets, direct links in either direction,
   and recurring-term overlap — computed from the in-memory note set. */

/** Wikilink targets a note points at, normalized for comparison. */
function outgoingLinks(content: string): Set<string> {
  const out = new Set<string>();
  for (const m of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = m[1].split(/[|#]/)[0].trim();
    if (target) out.add(target.toLowerCase());
  }
  return out;
}

const STOPWORDS = new Set([
  "about",
  "after",
  "also",
  "been",
  "before",
  "being",
  "does",
  "each",
  "from",
  "have",
  "into",
  "just",
  "made",
  "make",
  "more",
  "most",
  "much",
  "only",
  "other",
  "over",
  "some",
  "such",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "under",
  "very",
  "was",
  "were",
  "what",
  "when",
  "which",
  "while",
  "will",
  "with",
  "your",
]);

/** Lowercase word counts for terms of 4+ characters, minus stopwords. */
function termCounts(content: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of content.toLowerCase().matchAll(/[a-z][a-z0-9']{3,}/g)) {
    const w = m[0];
    if (STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return counts;
}

/**
 * Other notes most connected to `target`, best first. Signals: shared
 * outgoing wikilinks (+3 each), a direct link in either direction (+3), and
 * up to five recurring shared terms (+1 each). Pure function over the
 * in-memory files — no index, no network.
 */
export function relatedNotes(files: VaultFile[], target: string, limit = 5): VaultFile[] {
  const self = files.find((f) => f.path === target);
  if (!self) return [];
  const needle = `[[${fileName(target)}]]`;
  const selfOut = outgoingLinks(self.content);
  const selfTerms = termCounts(`${fileName(target)}\n${self.content}`);

  const scored: { file: VaultFile; score: number }[] = [];
  for (const f of files) {
    if (f.path === target) continue;
    let score = 0;
    const out = outgoingLinks(f.content);
    for (const t of selfOut) {
      if (out.has(t)) score += 3;
    }
    if (f.content.includes(needle)) score += 3;
    if (self.content.includes(`[[${fileName(f.path)}]]`)) score += 3;

    const terms = termCounts(`${fileName(f.path)}\n${f.content}`);
    let shared = 0;
    for (const term of selfTerms.keys()) {
      if (shared >= 5) break;
      if (terms.has(term)) shared += 1;
    }
    score += shared;

    if (score > 0) scored.push({ file: f, score });
  }
  scored.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  return scored.slice(0, limit).map((s) => s.file);
}

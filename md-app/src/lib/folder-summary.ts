/**
 * Folder summaries: aggregate the notes under one folder into a single
 * `ai_text` request and derive the summary note's path. Pure helpers so the
 * scope, prompt, and path rules are testable without Tauri.
 *
 * Scope is the caller's `files` list, which the backend already filtered by
 * `.quireignore` — excluded notes can never enter a summary. Writing is the
 * caller's normal note-write path: this module never touches the vault.
 */

import type { VaultFile } from "@/lib/vault";

/** Characters of note content sent as context; keeps prompts bounded. */
export const SUMMARY_CONTEXT_LIMIT = 12_000;

/** Notes under `folder`, nested folders included. `""` means the vault root. */
export function folderNotes(files: VaultFile[], folder: string): VaultFile[] {
  if (folder === "") return files;
  const prefix = `${folder.replace(/\/+$/, "")}/`;
  return files.filter((f) => f.path.startsWith(prefix));
}

/**
 * The instruction sent to the inline text seam for one folder. `count` is how
 * many notes actually made it into the context; when the budget dropped some,
 * `total` says how many are in scope so the summary can admit the gap.
 */
export function buildSummaryInstruction(folder: string, count: number, total = count): string {
  const label = folder === "" ? "this vault" : `the "${folder}" folder`;
  const lines = [
    `Summarize ${label} from the ${count} note(s) below.`,
    "Write markdown: one H1 title, a short overview paragraph, then the key",
    "points grouped by theme (bullet lists where they help).",
    "Use only the provided notes — do not invent facts. Mention open questions",
    "only when the notes clearly raise them. Aim for 200-400 words.",
  ];
  if (count < total) {
    lines.push(
      `Context limit: ${total - count} more note(s) are in scope but were not included — say so in the summary.`,
    );
  }
  return lines.join("\n");
}

/**
 * Concatenate the notes as fenced data with path headers, up to
 * `limit` characters. Whole notes only — a half note could mislead the model
 * into summarizing text that is not there.
 */
export function buildSummaryContext(
  files: VaultFile[],
  limit = SUMMARY_CONTEXT_LIMIT,
): { text: string; included: number; total: number } {
  const blocks: string[] = [];
  let used = 0;
  for (const file of files) {
    const block = `## ${file.path}\n\n${file.content.trim()}\n`;
    if (used + block.length > limit) break;
    blocks.push(block);
    used += block.length;
  }
  return { text: blocks.join("\n"), included: blocks.length, total: files.length };
}

/**
 * Vault-relative path for the summary note: `Summary.md` inside the folder
 * (or `Vault summary.md` at the root), suffixed `-2`, `-3`… on collision.
 */
export function summaryNotePath(folder: string, existing: string[]): string {
  const dir = folder === "" ? "" : `${folder.replace(/\/+$/, "")}/`;
  const base = folder === "" ? "Vault summary" : "Summary";
  const taken = new Set(existing.map((p) => p.toLowerCase()));
  let candidate = `${dir}${base}.md`;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${dir}${base}-${n}.md`;
    n += 1;
  }
  return candidate;
}

/** Human label for a folder path ("Vault root" for the root). */
export function folderLabel(folder: string): string {
  return folder === "" ? "Vault root" : folder;
}

/**
 * Create-note-through-AI: the description → `ai_text` → `note_write` flow.
 * Pure helpers here (instruction, path derivation) so they are testable
 * without Tauri. The note itself is the preview: it lands through the normal
 * note write path, so git/sync see an ordinary new file the user can edit
 * or delete like any other.
 */

/** The instruction sent to the inline text seam. */
export function buildNoteInstruction(description: string): string {
  return [
    "Write a complete markdown note from the description below.",
    `Description: ${description.trim()}`,
    "Start with a single H1 title for the note, then write useful, well-structured",
    "content (short sections, lists where they help). Keep it focused — roughly",
    "150-400 words unless the description clearly needs more.",
  ].join("\n");
}

const UNSAFE = /[/\\:*?"<>|]/g;

/**
 * Derive a vault-relative note path from the generated content: the first
 * H1 becomes the file name; collisions get -2, -3… suffixes. Falls back to
 * `Untitled` when no heading is found.
 */
export function notePathFromContent(content: string, existing: string[]): string {
  const heading = /^#\s+(.+)$/m.exec(content);
  const title = (heading?.[1] ?? "Untitled")
    .replace(/[#*_[\]]/g, "")
    .replace(UNSAFE, "-")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 60)
    .trim()
    .replace(/[-.]+$/, "");
  const base = (title || "Untitled").trim() || "Untitled";

  const taken = new Set(existing.map((p) => p.toLowerCase()));
  let candidate = `${base}.md`;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base}-${n}.md`;
    n += 1;
  }
  return candidate;
}

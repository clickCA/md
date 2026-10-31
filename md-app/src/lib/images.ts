import { invoke } from "@tauri-apps/api/core";

/* ── vault image resolution ─────────────────────────────────────────── */

/** Resolved data-URL cache, shared by the editor preview and the viewer. */
const imgCache = new Map<string, string>();

export function mimeOf(src: string): string {
  const clean = src.split(/[?#]/)[0].toLowerCase();
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".gif")) return "image/gif";
  if (clean.endsWith(".svg")) return "image/svg+xml";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".avif")) return "image/avif";
  if (clean.endsWith(".bmp")) return "image/bmp";
  return "application/octet-stream";
}

export function isImageRef(src: string): boolean {
  return /\.(png|jpe?g|gif|svg|webp|avif|bmp)$/i.test(src.split(/[?#]/)[0]);
}

/** True when the reference loads without touching the vault (remote or inline). */
export function isExternalImage(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src);
}

/**
 * Resolve a note image reference to a displayable URL.
 * Vault-relative paths are read through Tauri and cached as data URLs;
 * remote/data references pass through unchanged. Rejects on failure.
 */
export async function resolveImage(dir: string, src: string): Promise<string> {
  if (isExternalImage(src)) return src;
  const key = `${dir}|${src}`;
  const hit = imgCache.get(key);
  if (hit) return hit;
  const b64 = await invoke<string>("read_file_bytes", { dir, path: src });
  const url = `data:${mimeOf(src)};base64,${b64}`;
  imgCache.set(key, url);
  return url;
}

/* ── gallery extraction ─────────────────────────────────────────────── */

export type ImageRef = {
  /** raw source as written in the note (vault-relative path or URL) */
  src: string;
  alt: string;
};

const MD_IMAGE = /!\[([^\]]*)\]\(\s*(?:<([^>]*)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g;

/** Blank out regions where image syntax is literal text, not rendered markdown:
 *  fenced code blocks (``` / ~~~) and inline code spans. */
function stripNonRendered(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const open = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      out.push("");
      if (open && line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (open) {
      fence = open[1];
      out.push("");
      continue;
    }
    out.push(line.replace(/`[^`]*`/g, ""));
  }
  return out.join("\n");
}

/**
 * All images referenced by a note, in order of first appearance, deduped
 * by source. Drives the viewer's gallery so navigation follows the note.
 */
export function extractImages(content: string): ImageRef[] {
  const seen = new Set<string>();
  const out: ImageRef[] = [];
  for (const m of stripNonRendered(content).matchAll(MD_IMAGE)) {
    const src = (m[2] ?? m[3] ?? "").trim();
    if (!src || seen.has(src)) continue;
    seen.add(src);
    out.push({ src, alt: m[1].trim() });
  }
  return out;
}

/** Human label for the viewer chrome: alt text, else file name. */
export function imageLabel(ref: ImageRef): string {
  const alt = ref.alt.trim();
  if (alt) return alt;
  const name = ref.src.split("/").pop() ?? ref.src;
  return decodeURIComponent(name);
}

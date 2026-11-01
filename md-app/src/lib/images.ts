import { invoke } from "@tauri-apps/api/core";

/* ── vault image resolution ─────────────────────────────────────────── */

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

/** True when the reference loads without touching the vault (remote or inline). */
export function isExternalImage(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src);
}

/** True when the reference looks like an image file (used for paste/drop). */
export function isImageRef(src: string): boolean {
  return /\.(png|jpe?g|gif|svg|webp|avif|bmp)$/i.test(src.split(/[?#]/)[0]);
}

/** True when a note reference should render as a bitmap (vault or remote). */
export function isImageSource(src: string): boolean {
  return isExternalImage(src) || isImageRef(src);
}

/* ── Obsidian image embeds ──────────────────────────────────────────── */

const WIKI_EMBED = /!\[\[([^\]\n]+)\]\]/g;

/**
 * Split an Obsidian embed body (`path`, `path|alias`, `path|300`) into the
 * image source and alt text. A purely numeric alias is Obsidian's width
 * hint, not a label.
 */
export function wikiImageParts(inner: string): { src: string; alt: string } {
  const [rawSrc, ...rest] = inner.split("|");
  const src = rawSrc.trim();
  const alias = rest.join("|").trim();
  return { src, alt: alias && !/^\d+$/.test(alias) ? alias : "" };
}

/**
 * Rewrite Obsidian image embeds (`![[Images/shot.png]]`) into CommonMark
 * images so both the reading view and the gallery understand them. Embeds
 * that point at notes (no image extension) are left untouched — the
 * wikilink renderer handles those.
 */
export function expandImageEmbeds(content: string): string {
  return content.replace(WIKI_EMBED, (match, inner: string) => {
    const { src, alt } = wikiImageParts(inner);
    if (!src || !isImageRef(src)) return match;
    // Angle brackets keep destinations with raw spaces valid CommonMark.
    return `![${alt}](<${src}>)`;
  });
}

/* Markdown destinations keep the percent-encoding a link may carry
   (Obsidian writes `Images/Pasted%20image%20….png`); the filesystem wants
   the literal name. decodeURIComponent throws on stray `%`, so fall back. */
export function decodeImagePath(src: string): string {
  if (!src.includes("%")) return src;
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
}

/** Human label for a pending/missing image: alt text, else file name. */
export function imageLabel(src: string, alt: string): string {
  if (alt.trim()) return alt.trim();
  const name = decodeImagePath(src).split("/").pop() ?? src;
  return name;
}

/** Resolved data-URL cache, shared by every image site in the app. */
const imgCache = new Map<string, string>();

/**
 * Resolve a note image reference to a displayable URL. Vault-relative
 * paths are read through Tauri and cached as data URLs (the asset
 * protocol is not enabled, so `convertFileSrc` URLs would never load);
 * remote/data references pass through unchanged. Rejects on failure.
 */
export async function resolveImage(dir: string, src: string): Promise<string> {
  if (isExternalImage(src)) return src;
  const path = decodeImagePath(src);
  const key = `${dir}|${path}`;
  const hit = imgCache.get(key);
  if (hit) return hit;
  const b64 = await invoke<string>("read_file_bytes", { dir, path });
  const url = `data:${mimeOf(path)};base64,${b64}`;
  imgCache.set(key, url);
  return url;
}

/* ── pasted / dropped image files ───────────────────────────────────── */

/** The image files in a clipboard/drag payload, in transfer order. */
export function imageFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  return Array.from(dt.files ?? []).filter((f) => f.type.startsWith("image/"));
}

/** File extension to store the blob under (name first, mime as fallback). */
export function imageExt(file: File): string {
  const fromName = file.name.includes(".") ? file.name.split(".").pop() : null;
  return (fromName ?? file.type.split("/")[1] ?? "png").toLowerCase();
}

/** Base64 payload of a blob, as the `save_image` command expects. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("image read failed"));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(blob);
  });
}

/**
 * Store pasted/dropped image bytes in the vault (`save_image` puts them
 * under `assets/`) and return the vault-relative markdown to embed.
 */
export async function saveImage(dir: string, file: File): Promise<string> {
  const data = await blobToBase64(file);
  return invoke<string>("save_image", { dir, data, ext: imageExt(file) });
}

/* ── gallery extraction ─────────────────────────────────────────────── */

export type ImageRef = {
  /** raw source as written in the note (vault-relative path or URL) */
  src: string;
  alt: string;
};

const MD_IMAGE = /!\[([^\]]*)\]\(\s*(?:<([^>\n]*)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g;

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
 * Handles both CommonMark images and Obsidian `![[…]]` embeds.
 */
export function extractImages(content: string): ImageRef[] {
  const text = expandImageEmbeds(stripNonRendered(content));
  const seen = new Set<string>();
  const out: ImageRef[] = [];
  for (const m of text.matchAll(MD_IMAGE)) {
    const src = (m[2] ?? m[3] ?? "").trim();
    if (!src || seen.has(src)) continue;
    seen.add(src);
    out.push({ src, alt: m[1].trim() });
  }
  return out;
}

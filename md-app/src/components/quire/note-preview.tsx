import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { openUrl } from "@tauri-apps/plugin-opener";
import { imageLabel, isExternalImage, resolveImage } from "@/lib/images";
import { fileName, type VaultFile } from "@/lib/vault";
import { INLINE_TITLE_CLASS } from "./prose-classes";
// hljs token colors + the fenced-code reset: descendant rules that no
// react-markdown component override can express (see note-preview.css).
import "./note-preview.css";

type Props = {
  file: VaultFile;
  dir: string;
  onOpenLink: (title: string) => void;
  /** 0-based source line of a clicked task checkbox */
  onToggleTask: (line: number) => void;
};

const external = /^(https?:|data:|blob:|asset:)/i;

/* Markdown-element styling lives in the `components` map below as Tailwind
   utilities reusing the @theme tokens (text-heading, bg-muted, border-border,
   …); the old `.prose-note` descendant block is gone from index.css.
   Shared strings so each look is defined once. */
const LINK_CLASS =
  "text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary";
const LIST_CLASS = "my-3 flex flex-col gap-1 pl-5";
const HEADING_CLASS = "font-semibold text-heading";
const CELL_CLASS = "border border-border px-3 py-1.5 text-left";
const INLINE_CODE_CLASS = "rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[13px] text-primary";

/* Vault images load as data URLs via the `read_file_bytes` command, so they
   resolve asynchronously; until then (and on failure) the alt text stands
   in for the bitmap. Remount with key={src} in the caller to reset state. */
function PreviewImage({ src, alt, dir }: { src: string; alt?: string; dir: string }) {
  const external = isExternalImage(src);
  const [url, setUrl] = useState<string | null>(external ? src : null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (external) return;
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    resolveImage(dir, src)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [dir, src, external]);

  if (url)
    return (
      <img
        src={url}
        alt={alt}
        loading="lazy"
        className="max-w-full rounded-md border border-border"
      />
    );
  // Alt-text stand-in while the image loads / if it failed to load.
  return (
    <span
      className={
        failed
          ? `${IMAGE_STANDIN_CLASS} border-destructive/60 text-destructive`
          : `${IMAGE_STANDIN_CLASS} border-border text-muted-foreground`
      }
    >
      {imageLabel(src, alt ?? "")}
    </span>
  );
}

/* Minimal mdast shape we need for the task-list transform. */
type MdNode = {
  type: string;
  checked?: boolean | null;
  children?: MdNode[];
  position?: { start?: { line?: number } };
  data?: { hProperties?: Record<string, string> };
};

/* Task checkboxes synthesized by remark-rehype carry no source position,
   so tag each task list item with its source line here and render the
   checkbox ourselves in the `li` component below. */
function remarkTaskLines() {
  return (tree: MdNode) => {
    const walk = (node: MdNode) => {
      for (const child of node.children ?? []) {
        if (child.type === "listItem" && child.checked != null) {
          const line = child.position?.start?.line ?? 0;
          child.data = {
            hProperties: {
              "data-task": "true",
              "data-line": String(line),
              "data-checked": child.checked ? "true" : "false",
            },
          };
          child.checked = null; // let the `li` component own the checkbox
        }
        walk(child);
      }
    };
    walk(tree);
  };
}

/* Wikilinks are not part of standard markdown; rewrite them into inert
   fragment links purely for rendering (the file on disk is untouched). */
const wikiLink = /\[\[([^\]\n]+)\]\]/g;

function taskLabel(lines: string[], line: number) {
  return (lines[line - 1] ?? "").replace(/^\s*[-*+]\s+\[[ xX]\]\s*/, "").trim();
}

export function MarkdownPreview({ file, dir, onOpenLink, onToggleTask }: Props) {
  const source = file.content.replace(wikiLink, (_m, title: string) => {
    return `[${title}](#wiki:${encodeURIComponent(title)})`;
  });
  const sourceLines = source.split("\n");

  return (
    <div className="h-full overflow-y-auto">
      {/* `prose-note` remains only as the scope hook for note-preview.css. */}
      <article className="prose-note mx-auto max-w-3xl px-6 py-8 text-[16px] leading-[1.6] text-foreground sm:px-10 sm:py-10">
        <h1 className={INLINE_TITLE_CLASS}>{fileName(file.path)}</h1>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkTaskLines]}
          rehypePlugins={[
            // Token colors come from the .hljs rules in note-preview.css, which
            // reuse the same --hl-* palette as the editor. ignoreMissing: unknown
            // fence languages (mermaid, dot, …) render as plain code.
            [rehypeHighlight, { detect: false, ignoreMissing: true }],
          ]}
          components={{
            a: ({ children, href }) => {
              if (href?.startsWith("#wiki:")) {
                return (
                  <button
                    type="button"
                    className="md-wikilink"
                    onClick={() => onOpenLink(decodeURIComponent(href.slice(6)))}
                  >
                    {children}
                  </button>
                );
              }
              if (href && external.test(href)) {
                return (
                  <a
                    href={href}
                    onClick={(e) => {
                      e.preventDefault();
                      void openUrl(href);
                    }}
                  >
                    {children}
                  </a>
                );
              }
              if (href && !href.startsWith("#")) {
                // Relative link to another note — the workspace resolves it.
                return (
                  <a
                    href={href}
                    className="md-wikilink"
                    onClick={(e) => {
                      e.preventDefault();
                      onOpenLink(href);
                    }}
                  >
                    {children}
                  </a>
                );
              }
              return <a href={href}>{children}</a>;
            },
            img: ({ src, alt }) =>
              typeof src === "string" && src ? (
                <PreviewImage key={src} src={src} alt={alt} dir={dir} />
              ) : null,
            li: ({ children, ...rest }) => {
              const attrs = rest as Record<string, unknown>;
              delete attrs.node;
              if (attrs["data-task"] !== "true") return <li {...rest}>{children}</li>;
              const line = Number(attrs["data-line"]);
              return (
                <li {...rest} className="task-list-item">
                  <input
                    type="checkbox"
                    aria-label={taskLabel(sourceLines, line) || `task on line ${line}`}
                    checked={attrs["data-checked"] === "true"}
                    readOnly
                    onClick={() => line > 0 && onToggleTask(line - 1)}
                  />
                  {children}
                </li>
              );
            },
          }}
        >
          {source}
        </ReactMarkdown>
      </article>
    </div>
  );
}

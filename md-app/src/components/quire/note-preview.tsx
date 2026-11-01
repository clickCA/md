import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  useEffect,
  useMemo,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  expandImageEmbeds,
  extractImages,
  type ImageRef,
  imageLabel,
  isExternalImage,
  resolveImage,
} from "@/lib/images";
import { fileName, type VaultFile } from "@/lib/vault";
import { ImageViewer } from "./image-viewer";
import { INLINE_TITLE_CLASS } from "./prose-classes";

type Props = {
  file: VaultFile;
  dir: string;
  onOpenLink: (title: string) => void;
  /** 0-based source line of a clicked task checkbox */
  onToggleTask: (line: number) => void;
};

const external = /^(https?:|data:|blob:|asset:)/i;

/* Alt-text stand-in shape for a vault image that is still loading or failed
   to load; per-state color/border comes from the usage site. */
const IMAGE_STANDIN_CLASS =
  "inline-block rounded-md border border-dashed px-2 py-0.5 text-sm italic";

/* Markdown-element styling lives in the `components` map below as Tailwind
   utilities reusing the @theme tokens (text-heading, bg-muted, border-border,
   …). Nothing of this surface lives in a stylesheet any more. Shared strings
   so each look is defined once. */
const LINK_CLASS =
  "text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary";
const LIST_CLASS = "my-3 flex flex-col gap-1 pl-5";
const HEADING_CLASS = "font-semibold text-heading";
const CELL_CLASS = "border border-border px-3 py-1.5 text-left";
/* Inline code and fenced blocks get their type from `--code-font-family` /
   `--code-font-size` (Settings → Typography), so both track the same font. */
const INLINE_CODE_CLASS = "md-inline-code";
/* Fenced blocks: the `pre` override swaps the child <code>'s inline-code
   class for this one (keeping hljs/language classes), so the pill can never
   leak into a block — not even bare ``` fences with no language. */
const CODE_BLOCK_CLASS = "md-code-block";
/* rehype-highlight emits raw .hljs-* spans; the `span` override maps each
   token class to the shared --hl-* palette (same tokens the editor uses).
   Order matters: title.class_ must be tested before plain title. */
const HL_TOKEN_STYLES: Array<[RegExp, string]> = [
  [/^hljs-title\.class_$|^hljs-(type|params|name|tag)$/, "text-(--hl-type)"],
  [
    /^hljs-(title|section|selector-id|selector-class|selector-pseudo|attribute|attr)$/,
    "text-(--hl-fn)",
  ],
  [/^hljs-(keyword|selector-tag|built_in|doctag|deletion|variable)$/, "text-(--hl-kw)"],
  [/^hljs-(string|regexp|addition|template-variable)$/, "text-(--hl-str)"],
  [/^hljs-(number|literal|symbol|bullet|link)$/, "text-(--hl-num)"],
  [/^hljs-(comment|quote|meta)$/, "italic text-(--hl-com)"],
];

/* Vault images load as data URLs via the `read_file_bytes` command, so they
   resolve asynchronously; until then (and on failure) the alt text stands
   in for the bitmap. Remount with key={src} in the caller to reset state. */
function PreviewImage({
  src,
  alt,
  dir,
  onOpen,
}: {
  src: string;
  alt?: string;
  dir: string;
  onOpen: (src: string) => void;
}) {
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
        title="Click to open the image viewer"
        onClick={() => onOpen(src)}
        className="max-w-full cursor-zoom-in rounded-md border border-border"
      />
    );
  // Alt-text stand-in while the image loads / if it failed to load.
  return (
    <span
      data-image-state={failed ? "missing" : "pending"}
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
  const [viewer, setViewer] = useState<{ images: ImageRef[]; index: number } | null>(null);
  const gallery = useMemo(() => extractImages(file.content), [file.content]);
  const openImage = (src: string) => {
    const index = gallery.findIndex((im) => im.src === src);
    setViewer({
      images: gallery.length > 0 ? gallery : [{ src, alt: "" }],
      index: Math.max(0, index),
    });
  };

  // Obsidian embeds first (![[shot.png]]), then plain wikilinks — the
  // embed expansion must run before the bracket rewrite would mangle it.
  const source = expandImageEmbeds(file.content).replace(wikiLink, (_m, title: string) => {
    return `[${title}](#wiki:${encodeURIComponent(title)})`;
  });
  const sourceLines = source.split("\n");

  return (
    <>
      <div className="h-full overflow-y-auto">
        <article className="md-preview mx-auto max-w-3xl px-6 py-8 text-foreground sm:px-10 sm:py-10">
          <h1 className={INLINE_TITLE_CLASS}>{fileName(file.path)}</h1>
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkTaskLines]}
            rehypePlugins={[
              // Token colors come from the `span` override below, which maps
              // .hljs-* classes to the same --hl-* palette the editor uses.
              // ignoreMissing: unknown fence languages (mermaid, dot, …)
              // render as plain code.
              [rehypeHighlight, { detect: false, ignoreMissing: true }],
            ]}
            components={{
              h1: ({ children }) => (
                <h1 className="mt-6 mb-4 text-[1.6em] font-bold tracking-tight text-heading text-balance">
                  {children}
                </h1>
              ),
              h2: ({ children }) => (
                <h2 className={`mt-8 mb-3 text-[1.4em] ${HEADING_CLASS}`}>{children}</h2>
              ),
              h3: ({ children }) => (
                <h3 className={`mt-6 mb-2 text-[1.2em] ${HEADING_CLASS}`}>{children}</h3>
              ),
              h4: ({ children }) => (
                <h4 className={`mt-5 mb-2 text-[1.05em] ${HEADING_CLASS}`}>{children}</h4>
              ),
              h5: ({ children }) => (
                <h5 className={`mt-5 mb-2 text-[1.05em] ${HEADING_CLASS}`}>{children}</h5>
              ),
              h6: ({ children }) => (
                <h6 className={`mt-5 mb-2 text-[1.05em] ${HEADING_CLASS}`}>{children}</h6>
              ),
              p: ({ children }) => <p className="my-3 text-pretty">{children}</p>,
              ul: ({ children }) => <ul className={`${LIST_CLASS} list-disc`}>{children}</ul>,
              ol: ({ children }) => <ol className={`${LIST_CLASS} list-decimal`}>{children}</ol>,
              strong: ({ children }) => (
                <strong className="font-semibold text-foreground">{children}</strong>
              ),
              code: ({ className, children }) => {
                const classes = className?.split(/\s+/) ?? [];
                // Fenced blocks arrive here through the `pre` override below,
                // which adds CODE_BLOCK_CLASS before render; don't add the
                // inline pill on top of a block.
                const block = classes.includes(CODE_BLOCK_CLASS);
                const value = block
                  ? className
                  : className
                    ? `${className} ${INLINE_CODE_CLASS}`
                    : INLINE_CODE_CLASS;
                return <code className={value}>{children}</code>;
              },
              pre: ({ children }) => (
                <pre className="md-code-block-wrap">
                  {/* The child is the <code> component element (ReactMarkdown
                    passes components, not their output), so tag it with the
                    block class; `code` above then skips the inline pill. */}
                  {Children.map(children, (child) => {
                    if (!isValidElement(child)) return child;
                    const el = child as ReactElement<{ className?: string }>;
                    const language = (el.props.className ?? "")
                      .split(/\s+/)
                      .filter((cls) => cls && cls !== INLINE_CODE_CLASS);
                    return cloneElement(el, {
                      className: [...language, CODE_BLOCK_CLASS].join(" "),
                    });
                  })}
                </pre>
              ),
              span: ({ className, children }) => {
                const token = className
                  ?.split(/\s+/)
                  .map((c) => HL_TOKEN_STYLES.find(([re]) => re.test(c))?.[1])
                  .find(Boolean);
                return (
                  <span className={token ? `${className} ${token}` : className}>{children}</span>
                );
              },
              blockquote: ({ children }) => (
                <blockquote className="my-4 border-l-2 border-border pl-4 text-foreground/75">
                  {children}
                </blockquote>
              ),
              table: ({ children }) => (
                <table className="my-4 w-full border-collapse text-sm">{children}</table>
              ),
              th: ({ children }) => (
                <th className={`${CELL_CLASS} bg-muted font-medium`}>{children}</th>
              ),
              td: ({ children }) => <td className={CELL_CLASS}>{children}</td>,
              hr: () => <hr className="my-2 border-border" />,
              a: ({ children, href }) => {
                if (href?.startsWith("#wiki:")) {
                  return (
                    <button
                      type="button"
                      className={LINK_CLASS}
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
                      className={LINK_CLASS}
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
                      className={LINK_CLASS}
                      onClick={(e) => {
                        e.preventDefault();
                        onOpenLink(href);
                      }}
                    >
                      {children}
                    </a>
                  );
                }
                return (
                  <a href={href} className={LINK_CLASS}>
                    {children}
                  </a>
                );
              },
              img: ({ src, alt }) =>
                typeof src === "string" && src ? (
                  <PreviewImage key={src} src={src} alt={alt} dir={dir} onOpen={openImage} />
                ) : null,
              li: ({ children, ...rest }) => {
                const attrs = rest as Record<string, unknown>;
                delete attrs.node;
                if (attrs["data-task"] !== "true") return <li {...rest}>{children}</li>;
                const line = Number(attrs["data-line"]);
                return (
                  <li {...rest} className="-ml-5 list-none">
                    <input
                      type="checkbox"
                      aria-label={taskLabel(sourceLines, line) || `task on line ${line}`}
                      checked={attrs["data-checked"] === "true"}
                      readOnly
                      className="mr-2 align-middle accent-primary"
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
      {viewer && (
        <ImageViewer
          dir={dir}
          images={viewer.images}
          index={viewer.index}
          onNavigate={(index) => setViewer((v) => (v ? { ...v, index } : v))}
          onClose={() => setViewer(null)}
        />
      )}
    </>
  );
}

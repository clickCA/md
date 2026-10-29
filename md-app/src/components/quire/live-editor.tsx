import {
  type KeyboardEvent,
  type ReactNode,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import mermaid from "mermaid";
import hljs from "highlight.js/lib/common";
import { extractImages, resolveImage } from "@/lib/images";
import {
  type Block,
  type BlockKind,
  type EditorHandle,
  blockAt,
  findContentLine,
  headingLevel,
  kindOf,
  listPrefix,
  parseBlocks,
  toggleTask,
} from "@/lib/blocks";
import { type LineChange, type VaultFile, lineChanges } from "@/lib/vault";
import { cn } from "@/lib/utils";
import { ImageViewer } from "./image-viewer";

type Caret = number | "end";
type Active = { start: number; count: number; caret: Caret; nonce: number; sel?: boolean };

type Props = {
  dir: string;
  file: VaultFile;
  dark: boolean;
  onChange: (content: string) => void;
  onCursor: (line: number, col: number) => void;
  onOpenLink: (title: string) => void;
  existing: Set<string>;
};

const toLinks = (md: string) =>
  md.replace(
    /\[\[([^\]]+)\]\]/g,
    (_, title: string) => `[${title}](wiki:${encodeURIComponent(title)})`,
  );

function spacing(kind: BlockKind, level: number) {
  if (kind === "heading")
    return level === 1 ? "pt-2 pb-3" : level === 2 ? "pt-6 pb-1" : "pt-4 pb-1";
  if (kind === "list") return "py-0.5";
  return "py-2";
}

function sourceType(kind: BlockKind, level: number) {
  if (kind === "heading") {
    if (level === 1) return "font-sans text-3xl leading-tight font-semibold tracking-tight";
    if (level === 2) return "font-sans text-xl leading-snug font-semibold";
    return "font-sans text-base leading-7 font-semibold";
  }
  if (kind === "code" || kind === "table") return "font-mono text-[13px] leading-6";
  return "font-sans text-[15px] leading-7";
}

function changeIn(changes: LineChange[], start: number, end: number): LineChange {
  let found: LineChange = null;
  for (let i = start; i < end; i++) {
    if (changes[i] === "modified") return "modified";
    if (changes[i]) found = changes[i];
  }
  return found;
}

function ChangeMark({ change }: { change: LineChange }) {
  if (!change) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "absolute inset-y-1.5 -left-4 w-0.5 rounded-full",
        change === "added" ? "bg-added" : "bg-modified",
      )}
    />
  );
}

/* ── images ─────────────────────────────────────────────────────────── */

function VaultImage({
  dir,
  src,
  alt,
  onOpen,
}: {
  dir: string;
  src: string;
  alt: string;
  onOpen: (src: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    resolveImage(dir, src)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [dir, src]);

  if (!url) {
    return <span className="text-muted-foreground">🖼 {alt || src}</span>;
  }
  return (
    <img src={url} alt={alt} title="click to open the image viewer" onClick={() => onOpen(src)} onMouseDown={(e) => e.stopPropagation()} />
  );
}

/* ── mermaid + highlighted code blocks ──────────────────────────────── */

let mermaidSeq = 0;

function MermaidBlock({ code, dark }: { code: string; dark: boolean }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    mermaid.initialize({
      startOnLoad: false,
      theme: dark ? "dark" : "neutral",
      securityLevel: "strict",
    });
    const id = `mmd-${++mermaidSeq}`;
    mermaid
      .render(id, code)
      .then((r) => {
        if (!cancelled) {
          setSvg(r.svg);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code, dark]);

  if (failed || svg === null) {
    return <pre className="md-fence-err">{code}</pre>;
  }
  return <div className="md-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function CodeBlock({ text, dark }: { text: string; dark: boolean }) {
  const lines = text.split("\n");
  const open = (lines[0] ?? "").trim();
  const fence = open.startsWith("~~~") ? "~~~" : "```";
  const lang = open.slice(3).trim().toLowerCase();
  const closed = lines.length > 1 && (lines.at(-1) ?? "").trim().startsWith(fence);
  const body = lines.slice(1, closed ? lines.length - 1 : lines.length).join("\n");

  if (lang === "mermaid") return <MermaidBlock code={body} dark={dark} />;

  let html = "";
  try {
    if (lang && hljs.getLanguage(lang)) {
      html = hljs.highlight(body, { language: lang, ignoreIllegals: true }).value;
    }
  } catch {
    html = "";
  }

  return (
    <pre>
      {html ? (
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code className="hljs">{body}</code>
      )}
    </pre>
  );
}

/* ── editor ─────────────────────────────────────────────────────────── */

export const LiveEditor = forwardRef<EditorHandle, Props>(function LiveEditor(
  { dir, file, dark, onChange, onCursor, onOpenLink, existing },
  ref,
) {
  const [active, setActive] = useState<Active | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const nonce = useRef(0);
  const lines = file.content.split("\n");
  const changes = lineChanges(file);
  const gallery = useMemo(() => extractImages(file.content), [file.content]);

  const openViewer = (src: string) => {
    const i = gallery.findIndex((g) => g.src === src);
    setViewerIndex(i >= 0 ? i : 0);
  };

  const commit = (next: string[]) => onChange(next.join("\n"));
  const activate = (start: number, count: number, caret: Caret, sel?: boolean) =>
    setActive({ start, count, caret, nonce: ++nonce.current, sel });
  const activateLine = (source: string[], line: number, caret: Caret) => {
    const b = blockAt(source, line);
    activate(b.start, b.end - b.start, caret);
  };

  useImperativeHandle(ref, () => ({
    jumpTo: (line) => activateLine(lines, Math.max(0, Math.min(line, lines.length - 1)), 0),
  }));

  const cur =
    active && active.start < lines.length
      ? { ...active, count: Math.max(1, Math.min(active.count, lines.length - active.start)) }
      : null;
  const before = parseBlocks(lines, 0, cur ? cur.start : lines.length);
  const after = cur ? parseBlocks(lines, cur.start + cur.count, lines.length) : [];
  const activeValue = cur ? lines.slice(cur.start, cur.start + cur.count).join("\n") : "";

  const reportCursor = (el: HTMLTextAreaElement) => {
    if (!cur) return;
    const rows = el.value.slice(0, el.selectionStart).split("\n");
    onCursor(cur.start + rows.length, rows[rows.length - 1].length + 1);
  };

  const onActiveChange = (value: string) => {
    if (!cur) return;
    const count = value.split("\n").length;
    setActive((a) => (a ? { ...a, count } : a));
    commit([
      ...lines.slice(0, cur.start),
      ...value.split("\n"),
      ...lines.slice(cur.start + cur.count),
    ]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!cur || e.nativeEvent.isComposing || e.keyCode === 229) return;
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: t, value } = el;
    const pre = lines.slice(0, cur.start);
    const post = lines.slice(cur.start + cur.count);
    const replace = (text: string) => [...pre, ...text.split("\n"), ...post];
    const kind = kindOf(value.split("\n")[0]);

    if (e.key === "Escape") {
      e.preventDefault();
      el.blur();
      return;
    }

    // Ctrl+A selects the active block (browser default); pressing it again
    // with the block fully selected expands to the whole note. Without this,
    // selection is stuck inside the single-block textarea.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      const wholeBlock = s === 0 && t === value.length;
      const wholeNote = cur.start === 0 && cur.count === lines.length;
      if (wholeBlock && !wholeNote) {
        e.preventDefault();
        activate(0, lines.length, 0, true);
      }
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      if (kind === "list" && cur.count === 1) {
        const next = e.shiftKey ? value.replace(/^ {1,2}/, "") : `  ${value}`;
        const delta = next.length - value.length;
        commit(replace(next));
        requestAnimationFrame(() =>
          el.setSelectionRange(Math.max(0, s + delta), Math.max(0, t + delta)),
        );
      } else if (!e.shiftKey) {
        commit(replace(`${value.slice(0, s)}  ${value.slice(t)}`));
        requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
      }
      return;
    }

    if (e.key === "ArrowUp" && s === t && !value.slice(0, s).includes("\n")) {
      const prev = findContentLine(lines, cur.start - 1, -1);
      if (prev >= 0) {
        e.preventDefault();
        activateLine(lines, prev, "end");
      }
      return;
    }

    if (e.key === "ArrowDown" && s === t && !value.slice(s).includes("\n")) {
      const next = findContentLine(lines, cur.start + cur.count, 1);
      if (next >= 0) {
        e.preventDefault();
        activateLine(lines, next, 0);
      }
      return;
    }

    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      s === t &&
      (kind === "list" || kind === "heading" || kind === "paragraph")
    ) {
      const head = value.slice(0, s);
      const tail = value.slice(s);
      const lineStart = head.lastIndexOf("\n") + 1;
      const currentLine = head.slice(lineStart);
      let sep = "\n";
      let prefix = "";

      if (kind === "list") {
        const m = listPrefix(currentLine);
        if (!m) return;
        if (currentLine === m.full && !tail.trim()) {
          e.preventDefault();
          commit(replace(head.slice(0, lineStart) + tail));
          activate(cur.start, cur.count, lineStart);
          return;
        }
        prefix = m.next;
      } else if (kind === "paragraph") {
        if (!currentLine.trim()) return;
        sep = "\n\n";
      }

      e.preventDefault();
      commit(replace(head + sep + prefix + tail));
      activate(
        cur.start + (head + sep).split("\n").length - 1,
        (prefix + tail).split("\n").length,
        prefix.length,
      );
      return;
    }

    if (e.key === "Backspace" && s === 0 && t === 0 && cur.start > 0) {
      e.preventDefault();
      const prevIdx = cur.start - 1;
      const [first, ...rest] = value.split("\n");
      const prevLine = lines[prevIdx];
      const next = [...lines.slice(0, prevIdx), prevLine + first, ...rest, ...post];
      commit(next);
      const b = blockAt(next, prevIdx);
      const caret =
        next.slice(b.start, prevIdx).reduce((n, l) => n + l.length + 1, 0) + prevLine.length;
      activate(b.start, b.end - b.start, caret);
    }
  };

  const renderBlock = (b: Block) => (
    <RenderedBlock
      key={b.start}
      dir={dir}
      dark={dark}
      block={b}
      text={lines.slice(b.start, b.end).join("\n")}
      change={changeIn(changes, b.start, b.end)}
      onActivate={() => activate(b.start, b.end - b.start, "end")}
      onToggleTask={() => commit(toggleTask(lines, b.start))}
      onOpenLink={onOpenLink}
      onImage={openViewer}
      existing={existing}
    />
  );

  const activateEnd = () => {
    const last = findContentLine(lines, lines.length - 1, -1);
    if (last >= 0) activateLine(lines, last, "end");
    else activate(0, lines.length, "end");
  };

  const isEmpty = before.length === 0 && after.length === 0 && !cur;

  return (
    <div className="h-full overflow-y-auto">
      <article
        aria-label="Note"
        className="prose-note mx-auto flex min-h-full max-w-2xl flex-col px-5 py-8 sm:px-8 sm:py-10"
      >
        {before.map(renderBlock)}
        {cur && (
          <ActiveBlock
            key={`active-${cur.nonce}`}
            value={activeValue}
            caret={cur.caret}
            sel={cur.sel}
            change={changeIn(changes, cur.start, cur.start + cur.count)}
            onChange={onActiveChange}
            onKeyDown={onKeyDown}
            onBlur={() => setActive(null)}
            onCursor={reportCursor}
          />
        )}
        {after.map(renderBlock)}
        <div
          aria-hidden
          className="min-h-24 flex-1 cursor-text"
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            activateEnd();
          }}
        >
          {isEmpty && <p className="py-2 text-muted-foreground">Start writing…</p>}
        </div>
      </article>

      {viewerIndex !== null && gallery.length > 0 && (
        <ImageViewer
          dir={dir}
          images={gallery}
          index={viewerIndex}
          onNavigate={setViewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      )}
    </div>
  );
});

type ActiveProps = {
  value: string;
  caret: Caret;
  sel?: boolean;
  change: LineChange;
  onChange: (value: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onBlur: () => void;
  onCursor: (el: HTMLTextAreaElement) => void;
};

function ActiveBlock({
  value,
  caret,
  sel,
  change,
  onChange,
  onKeyDown,
  onBlur,
  onCursor,
}: ActiveProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const first = value.split("\n")[0] ?? "";
  const kind = kindOf(first);
  const level = headingLevel(first);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (sel) el.setSelectionRange(0, el.value.length);
    else {
      const pos = caret === "end" ? el.value.length : Math.min(caret, el.value.length);
      el.setSelectionRange(pos, pos);
    }
    onCursor(el);
    // Only on mount: each activation remounts this component with a fresh caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <div className={cn("relative -mx-3 rounded-md bg-muted/60 px-3", spacing(kind, level))}>
      <ChangeMark change={change} />
      <label htmlFor="live-block" className="sr-only">
        Markdown for this block
      </label>
      <textarea
        id="live-block"
        ref={ref}
        value={value}
        rows={1}
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value);
          onCursor(e.target);
        }}
        onSelect={(e) => onCursor(e.currentTarget)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        className={cn(
          "block w-full resize-none overflow-hidden bg-transparent text-foreground caret-primary outline-none",
          sourceType(kind, level),
        )}
      />
    </div>
  );
}

type RenderedProps = {
  dir: string;
  dark: boolean;
  block: Block;
  text: string;
  change: LineChange;
  onActivate: () => void;
  onToggleTask: () => void;
  onOpenLink: (title: string) => void;
  onImage: (src: string) => void;
  existing: Set<string>;
};

function RenderedBlock({
  dir,
  dark,
  block,
  text,
  change,
  onActivate,
  onToggleTask,
  onOpenLink,
  onImage,
  existing,
}: RenderedProps) {
  const level = block.kind === "heading" ? headingLevel(text) : 0;
  const indent = block.kind === "list" ? (text.match(/^ */)?.[0].length ?? 0) : 0;

  return (
    <div
      className={cn(
        "live-block relative -mx-3 cursor-text rounded-md px-3",
        spacing(block.kind, level),
      )}
      style={indent ? { paddingLeft: `calc(0.75rem + ${indent * 0.625}rem)` } : undefined}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        onActivate();
      }}
    >
      <ChangeMark change={change} />
      {block.kind === "code" ? (
        <CodeBlock text={text} dark={dark} />
      ) : (
        <MarkdownBlock
          dir={dir}
          text={text}
          indent={indent}
          onToggleTask={onToggleTask}
          onOpenLink={onOpenLink}
          onImage={onImage}
          existing={existing}
        />
      )}
    </div>
  );
}

function MarkdownBlock({
  dir,
  text,
  indent,
  onToggleTask,
  onOpenLink,
  onImage,
  existing,
}: {
  dir: string;
  text: string;
  indent: number;
  onToggleTask: () => void;
  onOpenLink: (title: string) => void;
  onImage: (src: string) => void;
  existing: Set<string>;
}) {
  const body = indent
    ? text
        .split("\n")
        .map((l) => l.slice(Math.min(indent, l.match(/^ */)?.[0].length ?? 0)))
        .join("\n")
    : text;

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) => url}
      components={{
        img: ({ src, alt }) => (
          <VaultImage
            dir={dir}
            src={typeof src === "string" ? src : ""}
            alt={alt ?? ""}
            onOpen={onImage}
          />
        ),
        input: ({ type, checked }) =>
          type === "checkbox" ? (
            <input
              type="checkbox"
              checked={!!checked}
              aria-label={checked ? "Mark task incomplete" : "Mark task complete"}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={onToggleTask}
              className="cursor-pointer"
            />
          ) : null,
        a: ({ href, children }): ReactNode => {
          if (href?.startsWith("wiki:")) {
            const title = decodeURIComponent(href.slice(5));
            const exists = existing.has(title);
            return (
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => onOpenLink(title)}
                className={
                  exists
                    ? "text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                    : "text-muted-foreground underline decoration-dashed underline-offset-2 hover:text-foreground"
                }
                title={exists ? `Open ${title}` : `Create ${title}`}
              >
                {children}
              </button>
            );
          }
          return (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              onMouseDown={(e) => e.stopPropagation()}
            >
              {children}
            </a>
          );
        },
      }}
    >
      {toLinks(body)}
    </ReactMarkdown>
  );
}

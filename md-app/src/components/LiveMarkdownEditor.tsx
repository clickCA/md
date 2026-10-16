import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import mermaid from "mermaid";
import hljs from "highlight.js/lib/common";

interface Props {
  dir: string;
  body: string;
  dark: boolean;
  onChange: (value: string) => void;
}

/* ── images ─────────────────────────────────────────────────────────── */

const imgCache = new Map<string, string>();

function mimeOf(src: string): string {
  if (src.endsWith(".png")) return "image/png";
  if (src.endsWith(".jpg") || src.endsWith(".jpeg")) return "image/jpeg";
  if (src.endsWith(".gif")) return "image/gif";
  if (src.endsWith(".svg")) return "image/svg+xml";
  if (src.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

function VaultImage({ dir, src, alt, onOpen }: { dir: string; src: string; alt: string; onOpen: (url: string) => void }) {
  const key = `${dir}|${src}`;
  const [url, setUrl] = useState<string | null>(imgCache.get(key) ?? null);

  useEffect(() => {
    if (/^https?:\/\//.test(src)) {
      setUrl(src);
      return;
    }
    if (imgCache.has(key)) {
      setUrl(imgCache.get(key)!);
      return;
    }
    invoke<string>("read_file_bytes", { dir, path: src })
      .then((b64) => {
        const u = `data:${mimeOf(src)};base64,${b64}`;
        imgCache.set(key, u);
        setUrl(u);
      })
      .catch(() => setUrl(null));
  }, [key, src]);

  if (!url) {
    return (
      <span className="md-link">
        🖼 {alt || src}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt={alt}
      className="md-img"
      title="click to enlarge"
      onClick={() => onOpen(url)}
    />
  );
}

/* ── mermaid ────────────────────────────────────────────────────────── */

let mermaidSeq = 0;

function MermaidBlock({ code, dark, heightPx }: { code: string; dark: boolean; heightPx: number }) {
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
    return <pre className="md-fence-body md-mmd-err">{code}</pre>;
  }
  return (
    <div
      className="md-mermaid"
      style={{ maxHeight: heightPx }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/* ── inline markdown ────────────────────────────────────────────────── */

function renderInline(text: string, dir: string, onImage: (url: string) => void): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re =
    /(!\[[^\]]*\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(`[^`]+`)|(~~[^~]+~~)|(\[[^\]]*\]\([^)]+\))/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("![")) {
      const t = tok.match(/!\[([^\]]*)\]\(([^)]+)\)/);
      nodes.push(<VaultImage key={key++} dir={dir} src={t?.[2] ?? ""} alt={t?.[1] ?? ""} onOpen={onImage} />);
    } else if (tok.startsWith("**")) {
      nodes.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("~~")) {
      nodes.push(<del key={key++}>{tok.slice(2, -2)}</del>);
    } else if (tok.startsWith("`")) {
      nodes.push(
        <span key={key++} className="md-code">
          {tok.slice(1, -1)}
        </span>,
      );
    } else if (tok.startsWith("[")) {
      const t = tok.match(/\[([^\]]*)\]\(([^)]+)\)/);
      nodes.push(
        <span key={key++} className="md-link" title={t?.[2]}>
          {t?.[1] || t?.[2]}
        </span>,
      );
    } else {
      nodes.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderBlockLine(line: string, inFence: boolean, dir: string, onImage: (url: string) => void): ReactNode {
  if (inFence) {
    return <span className="md-fence-body">{line || "\u00A0"}</span>;
  }
  const h = line.match(/^(#{1,6})\s+(.*)$/);
  if (h) {
    const level = h[1].length;
    return <span className={`md-heading md-h${level}`}>{renderInline(h[2], dir, onImage)}</span>;
  }
  if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
    return <span className="md-hr">───────────</span>;
  }
  const task = line.match(/^(\s*)[-*]\s+\[( |x|X)\]\s+(.*)$/);
  if (task) {
    const done = task[2].toLowerCase() === "x";
    return (
      <span className={done ? "md-task-done" : undefined}>
        {task[1]}
        <span className="md-task-box">{done ? "☑" : "☐"}</span> {renderInline(task[3], dir, onImage)}
      </span>
    );
  }
  const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
  if (bullet) {
    return (
      <>
        {bullet[1]}
        <span className="md-bullet">•</span> {renderInline(bullet[2], dir, onImage)}
      </>
    );
  }
  const numbered = line.match(/^(\s*)(\d+\.)\s+(.*)$/);
  if (numbered) {
    return (
      <>
        {numbered[1]}
        <span className="md-bullet">{numbered[2]}</span> {renderInline(numbered[3], dir, onImage)}
      </>
    );
  }
  const quote = line.match(/^>\s?(.*)$/);
  if (quote) {
    return <span className="md-quote">{renderInline(quote[1], dir, onImage)}</span>;
  }
  return <span>{renderInline(line, dir, onImage)}</span>;
}

/* ── editor ─────────────────────────────────────────────────────────── */

export default function LiveMarkdownEditor({ dir, body, dark, onChange }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const mirrorInnerRef = useRef<HTMLDivElement>(null);
  const [caretLine, setCaretLine] = useState(0);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const syncScroll = () => {
    const ta = taRef.current;
    const mirror = mirrorInnerRef.current;
    if (!ta || !mirror) return;
    mirror.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
  };

  const updateCaret = () => {
    const ta = taRef.current;
    if (!ta) return;
    const line = ta.value.slice(0, ta.selectionStart).split("\n").length - 1;
    setCaretLine(line);
    syncScroll();
  };

  useEffect(() => {
    updateCaret();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body]);

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length === 0) return;
    e.preventDefault();
    void (async () => {
      const ta = taRef.current;
      const insertions: string[] = [];
      for (const f of files) {
        const dataUrl = await new Promise<string>((res) => {
          const r = new FileReader();
          r.onload = () => res(r.result as string);
          r.readAsDataURL(f);
        });
        const b64 = dataUrl.split(",")[1] ?? "";
        const ext = (f.type.split("/")[1] ?? "png").replace("jpeg", "jpg");
        try {
          const rel = await invoke<string>("save_image", { dir, data: b64, ext });
          insertions.push(`![${f.name.replace(/\.[^.]+$/, "")}](${rel})`);
        } catch {
          insertions.push(`<!-- image save failed -->`);
        }
      }
      if (!ta || insertions.length === 0) return;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const insert = insertions.join("\n");
      const next = body.slice(0, start) + insert + body.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + insert.length;
        updateCaret();
      });
    })();
  };

  /* mirror build: fences (highlight.js), mermaid blocks, raw caret line */
  const lines = body.split("\n");
  const rendered: ReactNode[] = [];
  let i = 0;
  let inFence = false;
  let fenceLang = "";
  let mermaidLines: string[] = [];
  let mermaidStart = -1;

  const closeMermaid = (endLine: number) => {
    const code = mermaidLines.join("\n");
    const heightPx = (endLine - mermaidStart + 1) * 29 - 6;
    const activeNear = caretLine >= mermaidStart && caretLine <= endLine;
    if (activeNear) {
      for (let j = mermaidStart; j <= endLine; j++) {
        rendered.push(
          <div key={j} className="md-line">
            {j === caretLine ? lines[j] || "\u00A0" : <span className="md-fence-body">{lines[j]}</span>}
          </div>,
        );
      }
    } else {
      rendered.push(<MermaidBlock key={`mmd:${mermaidStart}`} code={code} dark={dark} heightPx={heightPx} />);
    }
    mermaidLines = [];
    mermaidStart = -1;
  };

  while (i < lines.length) {
    const line = lines[i];
    const active = i === caretLine;
    const isFenceMarker = line.trimStart().startsWith("```");

    if (inFence && isFenceMarker) {
      if (fenceLang === "mermaid") {
        closeMermaid(i);
      } else {
        rendered.push(
          <div key={i} className="md-line">
            {active ? line || "\u00A0" : <span className="md-fence-marker">{line}</span>}
          </div>,
        );
      }
      inFence = false;
      fenceLang = "";
      i++;
      continue;
    }

    if (inFence) {
      if (fenceLang === "mermaid") {
        if (active) {
          // raw while editing inside the block
          rendered.push(
            <div key={i} className="md-line">
              {line || "\u00A0"}
            </div>,
          );
        } else {
          mermaidLines.push(line);
        }
      } else {
        let html = "";
        try {
          if (hljs.getLanguage(fenceLang)) {
            html = hljs.highlight(line, { language: fenceLang, ignoreIllegals: true }).value;
          }
        } catch {
          html = "";
        }
        rendered.push(
          <div key={i} className="md-line">
            {active ? (
              line || "\u00A0"
            ) : html ? (
              <span className="md-fence-body" dangerouslySetInnerHTML={{ __html: html }} />
            ) : (
              <span className="md-fence-body">{line || "\u00A0"}</span>
            )}
          </div>,
        );
      }
      i++;
      continue;
    }

    if (isFenceMarker) {
      fenceLang = line.trim().slice(3).trim().toLowerCase();
      inFence = true;
      if (fenceLang === "mermaid") {
        mermaidLines = [];
        mermaidStart = i;
        rendered.push(
          <div key={i} className="md-line">
            {active ? line || "\u00A0" : <span className="md-fence-marker">{line}</span>}
          </div>,
        );
        i++;
        continue;
      }
      rendered.push(
        <div key={i} className="md-line">
          {active ? line || "\u00A0" : <span className="md-fence-marker">{line}</span>}
        </div>,
      );
      i++;
      continue;
    }

    rendered.push(
      <div key={i} className="md-line">
        {active ? line || "\u00A0" : renderBlockLine(line, false, dir, (u) => setLightbox(u))}
      </div>,
    );
    i++;
  }
  if (inFence && fenceLang === "mermaid" && mermaidStart >= 0) {
    closeMermaid(lines.length - 1);
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          ref={mirrorInnerRef}
          aria-hidden
          className="mx-auto max-w-[72ch] px-6 py-8 text-[17px] leading-[29px]"
          style={{ fontFamily: "var(--font-prose)" }}
        >
          {rendered}
        </div>
      </div>
      <textarea
        ref={taRef}
        value={body}
        onChange={(e) => {
          onChange(e.target.value);
          updateCaret();
        }}
        onKeyUp={updateCaret}
        onClick={updateCaret}
        onSelect={updateCaret}
        onScroll={syncScroll}
        onPaste={onPaste}
        spellCheck={true}
        placeholder="Write something…"
        className="live-md-input absolute inset-0 resize-none bg-transparent px-6 py-8 text-[17px] leading-[29px] outline-none placeholder:text-text-2"
        style={{ fontFamily: "var(--font-prose)" }}
      />
      {/* image lightbox */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} className="max-h-full max-w-full rounded-lg shadow-2xl" />
        </div>
      )}
    </div>
  );
}

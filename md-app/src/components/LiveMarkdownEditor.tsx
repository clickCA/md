import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  body: string;
  onChange: (value: string) => void;
}

/** Width-safe inline markdown → styled spans (same font/size, so wrapping matches the textarea). */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re =
    /(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(`[^`]+`)|(~~[^~]+~~)|(!?\[[^\]]*\]\([^)]*\))/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
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
      const t = tok.match(/!?\[([^\]]*)\]\(([^)]*)\)/);
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

function renderBlockLine(line: string, inFence: boolean): ReactNode {
  if (inFence) {
    return <span className="md-fence-body">{line || "\u00A0"}</span>;
  }
  const h = line.match(/^(#{1,6})\s+(.*)$/);
  if (h) {
    const level = h[1].length;
    return (
      <span className={`md-heading md-h${level}`}>{renderInline(h[2])}</span>
    );
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
        <span className="md-task-box">{done ? "☑" : "☐"}</span> {renderInline(task[3])}
      </span>
    );
  }
  const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
  if (bullet) {
    return (
      <>
        {bullet[1]}
        <span className="md-bullet">•</span> {renderInline(bullet[2])}
      </>
    );
  }
  const numbered = line.match(/^(\s*)(\d+\.)\s+(.*)$/);
  if (numbered) {
    return (
      <>
        {numbered[1]}
        <span className="md-bullet">{numbered[2]}</span> {renderInline(numbered[3])}
      </>
    );
  }
  const quote = line.match(/^>\s?(.*)$/);
  if (quote) {
    return <span className="md-quote">{renderInline(quote[1])}</span>;
  }
  return <span>{renderInline(line)}</span>;
}

/**
 * Single-view live markdown editor: a transparent textarea on top of a
 * rendered mirror. The line containing the caret shows raw markdown;
 * all other lines render as formatted text. The file stays plain markdown.
 */
export default function LiveMarkdownEditor({ body, onChange }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const mirrorInnerRef = useRef<HTMLDivElement>(null);
  const [caretLine, setCaretLine] = useState(0);

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

  const lines = body.split("\n");
  const rendered: ReactNode[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const active = i === caretLine;
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      rendered.push(
        <div key={i} className={`md-line ${active ? "" : inFence ? "md-fence-open" : "md-fence-open"}`}>
          {active ? line || "\u00A0" : <span className="md-fence-marker">{line}</span>}
        </div>,
      );
      continue;
    }
    rendered.push(
      <div key={i} className="md-line">
        {active ? (
          line || "\u00A0"
        ) : (
          renderBlockLine(line, inFence)
        )}
      </div>,
    );
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {/* rendered mirror */}
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
      {/* input layer: transparent text, visible caret/selection */}
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
        spellCheck={true}
        placeholder="Write something…"
        className="live-md-input absolute inset-0 resize-none bg-transparent px-6 py-8 text-[17px] leading-[29px] outline-none placeholder:text-text-2"
        style={{ fontFamily: "var(--font-prose)" }}
      />
    </div>
  );
}

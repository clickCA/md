import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import type { EditorHandle } from "@/lib/blocks";
import type { VaultFile } from "@/lib/vault";

type Props = {
  file: VaultFile;
  onChange: (content: string) => void;
  onCursor: (line: number, col: number) => void;
};

export const SourceEditor = forwardRef<EditorHandle, Props>(function SourceEditor(
  { file, onChange, onCursor },
  ref,
) {
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    jumpTo: (line) => {
      const el = areaRef.current;
      if (!el) return;
      const offset = el.value.split("\n").slice(0, line).join("\n").length + (line > 0 ? 1 : 0);
      el.focus();
      el.setSelectionRange(offset, offset);
    },
  }));

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [file.content]);

  const reportCursor = (el: HTMLTextAreaElement) => {
    const rows = el.value.slice(0, el.selectionStart).split("\n");
    onCursor(rows.length, rows[rows.length - 1].length + 1);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-5 py-8 sm:px-8 sm:py-10">
        <label htmlFor="note-source" className="sr-only">
          Markdown source
        </label>
        <textarea
          id="note-source"
          ref={areaRef}
          value={file.content}
          spellCheck={false}
          onChange={(e) => {
            onChange(e.target.value);
            reportCursor(e.target);
          }}
          onSelect={(e) => reportCursor(e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key !== "Tab") return;
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: start, selectionEnd: end } = el;
            onChange(`${el.value.slice(0, start)}  ${el.value.slice(end)}`);
            requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
          }}
          className="block w-full resize-none overflow-hidden bg-transparent font-mono text-[14px] leading-7 text-foreground caret-primary outline-none"
        />
      </div>
    </div>
  );
});

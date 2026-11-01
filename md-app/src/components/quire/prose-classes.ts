/* Look shared by the Obsidian-style inline note title in BOTH surfaces:
   the read-mode preview (note-preview.tsx) and the editor's CodeMirror
   widget (note-editor.tsx, InlineTitleWidget).
   Spacing is PADDING, not margin — CodeMirror measures the widget by
   offsetHeight, which excludes margins; a margin here desyncs the click
   hitboxes of every line below the title by the margin size. */
export const INLINE_TITLE_CLASS =
  "m-0 cursor-text px-0 pt-[8px] pb-[12px] text-[1.8em] font-bold leading-[1.25] tracking-[-0.01em] text-heading";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  crosshairCursor,
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  highlightSpecialChars,
  keymap,
  rectangularSelection,
  WidgetType,
} from "@codemirror/view";
import { type Extension, Compartment, EditorState } from "@codemirror/state";
import {
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fileName, type VaultFile } from "@/lib/vault";
import { TYPOGRAPHY_EVENT } from "@/lib/typography";
import { extractImages, type ImageRef, imageFiles, saveImage } from "@/lib/images";
import { ImageViewer } from "./image-viewer";
import { mdLivePreview } from "./live-preview";
import { INLINE_TITLE_CLASS } from "./prose-classes";
import { tableKeymap } from "./table-editing";

export type EditorHandle = { jumpTo: (line: number) => void };

const externalHref = /^(https?:|data:|blob:|asset:)/i;

/* Paste/drop an image file: store it under `assets/` via the backend and
   embed the returned vault-relative path as markdown at the caret. */
async function insertImages(view: EditorView, dir: string, files: File[]) {
  for (const file of files) {
    try {
      const rel = await saveImage(dir, file);
      const md = `![](${rel})`;
      const pos = view.state.selection.main.head;
      view.dispatch({
        changes: { from: pos, insert: md },
        selection: { anchor: pos + md.length },
        userEvent: "input.paste",
      });
    } catch (e) {
      console.error("image paste failed", e);
    }
  }
  view.focus();
}

/* Same pieces as basicSetup, minus fold gutter, autocompletion, bracket
   closing, line numbers and the default highlight style (we bring our own). */
const editorSetup: Extension = [
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  rectangularSelection(),
  crosshairCursor(),
  keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap]),
];

type Props = {
  file: VaultFile;
  /** Vault root — where pasted images get stored (`assets/…`). */
  dir: string;
  onChange: (content: string) => void;
  onCursor: (line: number, col: number) => void;
  dark: boolean;
  /** Ctrl/Cmd+click on a [[wikilink]] opens that note (same as read mode). */
  onOpenLink?: (title: string) => void;
};

/* ── markdown + generic code tokens, wired to the app syntax palette ─── */

const mdHighlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: "600", color: "var(--foreground)" },
  { tag: t.heading1, fontSize: "1.25em" },
  { tag: t.heading2, fontSize: "1.12em" },
  { tag: t.strong, fontWeight: "700", color: "var(--foreground)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--muted-foreground)" },
  { tag: t.link, color: "var(--primary)" },
  { tag: t.url, color: "var(--muted-foreground)" },
  { tag: t.quote, color: "color-mix(in oklab, var(--foreground) 75%, transparent)" },
  { tag: t.contentSeparator, color: "var(--muted-foreground)" },
  { tag: t.processingInstruction, color: "var(--muted-foreground)" },
  { tag: t.escape, color: "var(--primary)" },
  { tag: t.character, color: "var(--primary)" },
  { tag: t.keyword, color: "var(--hl-kw)" },
  { tag: t.string, color: "var(--hl-str)" },
  { tag: t.number, color: "var(--hl-num)" },
  { tag: t.bool, color: "var(--hl-num)" },
  { tag: t.atom, color: "var(--hl-num)" },
  { tag: t.null, color: "var(--hl-num)" },
  { tag: t.self, color: "var(--hl-kw)" },
  { tag: t.comment, color: "var(--hl-com)", fontStyle: "italic" },
  { tag: t.meta, color: "var(--hl-com)" },
  { tag: t.function(t.variableName), color: "var(--hl-fn)" },
  { tag: t.propertyName, color: "var(--hl-fn)" },
  { tag: t.typeName, color: "var(--hl-type)" },
  { tag: t.className, color: "var(--hl-type)" },
  { tag: t.tagName, color: "var(--hl-type)" },
  { tag: t.attributeName, color: "var(--hl-fn)" },
  { tag: t.labelName, color: "var(--hl-fn)" },
]);

/* Inline title above the content, scrolling with the document. */
class InlineTitleWidget extends WidgetType {
  constructor(readonly title: string) {
    super();
  }

  eq(other: InlineTitleWidget) {
    return other.title === this.title;
  }

  toDOM(view: EditorView) {
    const el = document.createElement("h1");
    el.className = INLINE_TITLE_CLASS;
    el.textContent = this.title;
    // Clicking the title enters the document at its very top — same as
    // Obsidian's inline title. Without this, ignoreEvent() below would make
    // CodeMirror swallow the click entirely (no focus, no caret).
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: 0 }, userEvent: "select.pointer" });
      view.focus();
    });
    return el;
  }

  ignoreEvent() {
    return true;
  }
}

/* Transparent editor surface so it blends with the app background; all
   colors come from CSS variables, so the light/dark switch is automatic. */
function makeTheme(dark: boolean) {
  return EditorView.theme(
    {
      "&": { height: "100%", backgroundColor: "transparent", color: "var(--foreground)" },
      ".cm-scroller": {
        fontFamily: "var(--editor-font-family)",
        fontSize: "var(--editor-font-size)",
        lineHeight: "1.65",
        fontKerning: "normal",
        textRendering: "optimizeLegibility",
      },
      /* Reading measure: the 48rem column from the old wrapper, now applied to
         the content itself (with its side gutters) so the scroller spans the
         full pane and its scrollbar docks at the right edge. clamp() stands in
         for the px-6/sm:px-10 media queries a theme object can't express. */
      ".cm-content": {
        maxWidth: "48rem",
        margin: "0 auto",
        caretColor: "var(--primary)",
        padding: "4px clamp(1.5rem, 4vw, 2.5rem) 40vh",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)" },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
        backgroundColor: "color-mix(in oklab, var(--primary) 30%, transparent)",
      },
      ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--foreground)" },
      ".cm-panels.cm-search": { borderBottom: "1px solid var(--border)" },
      ".cm-panel.cm-search label": { fontSize: "12px" },
      ".cm-searchMatch": {
        backgroundColor: "color-mix(in oklab, var(--primary) 25%, transparent)",
      },
      ".cm-searchMatch-selected": {
        backgroundColor: "color-mix(in oklab, var(--primary) 45%, transparent)",
      },

      /* ── inline markdown preview (live-preview.ts decorations) ────────── */
      ".cm-md-strong": { fontWeight: "700", color: "var(--foreground)" },
      ".cm-md-em": { fontStyle: "italic" },
      ".cm-md-strike": { textDecoration: "line-through", color: "var(--muted-foreground)" },
      ".cm-md-inlinecode": {
        backgroundColor: "color-mix(in oklab, var(--muted) 70%, transparent)",
        border: "1px solid color-mix(in oklab, var(--border) 70%, transparent)",
        borderRadius: "4px",
        padding: "1px 5px",
        fontFamily: "var(--code-font-family)",
        fontSize: "var(--code-font-size)",
        fontVariantLigatures: "contextual",
        lineHeight: "1.35",
        color: "var(--primary)",
      },
      ".cm-md-link": {
        color: "var(--primary)",
        textDecoration: "underline",
        textUnderlineOffset: "2px",
        textDecorationColor: "color-mix(in oklab, var(--primary) 40%, transparent)",
      },
      /* Same look as read-mode links (note-preview.tsx LINK_CLASS). */
      ".cm-md-wikilink": {
        color: "var(--primary)",
        textDecoration: "underline",
        textUnderlineOffset: "2px",
        textDecorationColor: "color-mix(in oklab, var(--primary) 40%, transparent)",
        cursor: "pointer",
      },
      ".cm-md-image": { color: "var(--muted-foreground)", fontStyle: "italic" },
      ".cm-md-image-widget": {
        display: "inline-block",
        fontStyle: "normal",
        cursor: "zoom-in",
        maxWidth: "100%",
        verticalAlign: "middle",
      },
      ".cm-md-image-widget img": {
        display: "block",
        maxWidth: "100%",
        borderRadius: "6px",
        border: "1px solid var(--border)",
      },
      ".cm-md-image-missing": { color: "var(--destructive, #b91c1c)" },
      ".cm-md-syntax": { color: "var(--muted-foreground)" },
      ".cm-md-heading": { fontWeight: "700", color: "var(--heading)" },
      ".cm-md-h1": { fontSize: "1.6em" },
      ".cm-md-h2": { fontSize: "1.4em" },
      ".cm-md-h3": { fontSize: "1.2em" },
      ".cm-md-h4, .cm-md-h5, .cm-md-h6": { fontSize: "1.05em" },
      ".cm-md-quote": {
        borderLeft: "2px solid var(--border)",
        paddingLeft: "12px",
        color: "color-mix(in oklab, var(--foreground) 75%, transparent)",
      },
      ".cm-md-codeblock": {
        backgroundColor: "color-mix(in oklab, var(--panel) 88%, transparent)",
        borderLeft: "2px solid color-mix(in oklab, var(--primary) 35%, transparent)",
        paddingLeft: "14px",
        paddingRight: "14px",
        fontFamily: "var(--code-font-family)",
        fontSize: "var(--code-font-size)",
        fontVariantLigatures: "contextual",
        lineHeight: "1.65",
      },
      /* YAML frontmatter: one muted block; no HR widgets inside it. */
      ".cm-md-frontmatter": {
        color: "var(--muted-foreground)",
        fontFamily: "var(--code-font-family)",
        fontSize: "0.85em",
      },
      /* Obsidian's ==highlight==. */
      ".cm-md-highlight": {
        backgroundColor: "color-mix(in oklab, var(--primary) 20%, transparent)",
        borderRadius: "3px",
        padding: "1px 2px",
      },
      ".cm-md-hr": { border: "none", borderTop: "1px solid var(--border)", margin: "8px 0" },
      ".cm-md-task": {
        display: "inline-block",
        width: "15px",
        height: "15px",
        margin: "0 6px 0 0",
        border: "1px solid var(--muted-foreground)",
        borderRadius: "4px",
        verticalAlign: "-2px",
        cursor: "pointer",
        position: "relative",
      },
      '.cm-md-task[data-checked="true"]': {
        backgroundColor: "var(--primary)",
        borderColor: "var(--primary)",
      },
      '.cm-md-task[data-checked="true"]::after': {
        content: '""',
        position: "absolute",
        left: "4px",
        top: "1px",
        width: "4px",
        height: "8px",
        borderRight: "2px solid var(--primary-foreground)",
        borderBottom: "2px solid var(--primary-foreground)",
        transform: "rotate(45deg)",
      },

      /* ── tables ────────────────────────────────────────────────────────
         Inactive tables read as a table: the header carries the row tint,
         pipes recede, and the delimiter line is replaced with a hairline
         (TableRuleWidget). Entering the table shows the raw markdown again,
         so the text under the caret is always exactly what gets saved. */
      ".cm-md-table-header": {
        backgroundColor: "color-mix(in oklab, var(--muted) 55%, transparent)",
        fontWeight: "600",
        color: "var(--foreground)",
      },
      ".cm-md-table-row": {
        backgroundColor: "color-mix(in oklab, var(--muted) 18%, transparent)",
      },
      ".cm-md-table-pipe": {
        color: "var(--muted-foreground)",
        opacity: "0.55",
      },
      ".cm-md-table-rule-widget": {
        display: "inline-block",
        width: "100%",
        height: "1px",
        verticalAlign: "middle",
        backgroundColor: "var(--border)",
      },
    },
    { dark },
  );
}

const themeCompartment = new Compartment();

export const MarkdownEditor = forwardRef<EditorHandle, Props>(function MarkdownEditor(
  { file, dir, onChange, onCursor, onOpenLink, dark },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const callbacks = useRef({ dir, onChange, onCursor, onOpenLink });
  useEffect(() => {
    callbacks.current = { dir, onChange, onCursor, onOpenLink };
  });

  // Full-screen image viewer, opened by clicking a rendered image. The
  // gallery mirrors the note's image order, read from the live buffer.
  const [viewer, setViewer] = useState<{ images: ImageRef[]; index: number } | null>(null);
  const openImage = (src: string) => {
    const content = viewRef.current?.state.doc.toString() ?? file.content;
    const gallery = extractImages(content);
    const index = gallery.findIndex((im) => im.src === src);
    setViewer({
      images: gallery.length > 0 ? gallery : [{ src, alt: "" }],
      index: Math.max(0, index),
    });
  };

  useImperativeHandle(ref, () => ({
    jumpTo: (line) => {
      const view = viewRef.current;
      if (!view) return;
      const target = Math.min(Math.max(line, 0), view.state.doc.lines - 1);
      const info = view.state.doc.line(target + 1);
      view.dispatch({ selection: { anchor: info.from }, scrollIntoView: true });
      view.focus();
    },
  }));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: file.content,
        extensions: [
          // Table keys first: Tab must move cells rather than indent, and
          // Enter must grow the table rather than continue the markdown line.
          // They only act when the caret is inside a table, so the normal
          // markdown bindings below still own everything else.
          keymap.of([...tableKeymap, ...markdownKeymap, indentWithTab]),
          editorSetup,
          // codeLanguages: fenced blocks (```rust …) get real parsing for the
          // language named after the fence. Each grammar lazy-loads on first
          // use, so startup cost stays flat no matter how many are bundled.
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          mdLivePreview({ dir, onOpenImage: openImage }),
          // Ctrl/Cmd+click follows links: [[wikilinks]] and relative
          // markdown links open that note, external URLs open in the system
          // browser. Plain clicks are untouched — they place the caret and
          // reveal the line's raw syntax.
          EditorView.domEventHandlers({
            mousedown: (event) => {
              if (!(event.metaKey || event.ctrlKey)) return false;
              const target = event.target as Element | null;
              const wiki = target?.closest("[data-wikilink]");
              if (wiki) {
                const open = callbacks.current.onOpenLink;
                if (open) {
                  event.preventDefault();
                  open(wiki.getAttribute("data-wikilink") ?? "");
                  return true;
                }
              }
              const anchor = target?.closest("[data-href]");
              const href = anchor?.getAttribute("data-href") ?? "";
              if (anchor && href && !href.startsWith("#") && !externalHref.test(href)) {
                // Relative link to another note — the workspace resolves it
                // against the current note's folder.
                const open = callbacks.current.onOpenLink;
                if (open) {
                  event.preventDefault();
                  open(href);
                  return true;
                }
              }
              if (anchor && externalHref.test(href)) {
                event.preventDefault();
                void openUrl(href).catch(() => undefined);
                return true;
              }
              return false;
            },
            /* Image paste/drop: clipboard screenshots and dragged image files
               are stored in the vault and embedded as markdown. Text paste
               (no files) falls through to CodeMirror's default handling. */
            paste: (event, view) => {
              const files = imageFiles(event.clipboardData);
              if (!files.length) return false;
              event.preventDefault();
              void insertImages(view, callbacks.current.dir, files);
              return true;
            },
            dragover: (event) => {
              if (!imageFiles(event.dataTransfer).length) return false;
              // Without this the webview navigates to the dropped file.
              event.preventDefault();
              return true;
            },
            drop: (event, view) => {
              const files = imageFiles(event.dataTransfer);
              if (!files.length) return false;
              event.preventDefault();
              void insertImages(view, callbacks.current.dir, files);
              return true;
            },
          }),
          indentUnit.of("  "),
          EditorView.lineWrapping,
          themeCompartment.of(makeTheme(dark)),
          syntaxHighlighting(mdHighlight),
          EditorView.decorations.of(
            Decoration.set([
              Decoration.widget({
                widget: new InlineTitleWidget(fileName(file.path)),
                side: -1,
                block: true,
              }).range(0),
            ]),
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
            if (update.selectionSet) {
              const head = update.state.selection.main.head;
              const pos = update.state.doc.lineAt(head);
              callbacks.current.onCursor(pos.number, head - pos.from + 1);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editor is remounted per file (key)
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeCompartment.reconfigure(makeTheme(dark)) });
  }, [dark]);

  // Typography settings change only CSS custom properties; CodeMirror needs a
  // fresh measure so line heights, scroll bounds and click hitboxes follow
  // the new font/size.
  useEffect(() => {
    const remeasure = () => viewRef.current?.requestMeasure();
    document.addEventListener(TYPOGRAPHY_EVENT, remeasure);
    return () => document.removeEventListener(TYPOGRAPHY_EVENT, remeasure);
  }, []);

  // Adopt external edits (e.g. a sync pull changed this note on disk).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (file.content !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: file.content } });
    }
  }, [file.content]);

  return (
    <div className="h-full min-h-0">
      {/* Full-width host: CodeMirror owns the scroller (virtual scrolling
          requires it), so centering must live INSIDE .cm-content — a centered
          wrapper here would dock the scrollbar to the text column instead of
          the editor pane's right edge. Mirrors note-preview.tsx's structure. */}
      <div ref={hostRef} className="h-full" />
      {viewer && (
        <ImageViewer
          dir={dir}
          images={viewer.images}
          index={viewer.index}
          onNavigate={(index) => setViewer((v) => (v ? { ...v, index } : v))}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
});

import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { SyntaxNodeRef } from "@lezer/common";
import { type Extension, type Range } from "@codemirror/state";

/* ── Typora-style inline markdown preview ──────────────────────────────
   The markdown syntax tree drives three kinds of decorations:
   - mark/line classes that style text as it renders (always on)
   - replace decorations that collapse raw syntax (##, **, [](url)…) out
     of the layout on lines the cursor/selection is not touching, so the
     page reads like rendered markdown — headings flush, bold clean
   - replace widgets for constructs that genuinely need custom rendering
     (task checkboxes, horizontal rules).
   The cursor's line always shows its raw markdown. Collapsed syntax is
   NOT atomic: clicks map through the live DOM, so the caret lands on the
   character you clicked and the line reveals in place (Obsidian's
   behavior). Only replaced widgets are atomic — there is no text in a
   checkbox to click or step through. */

class TaskWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
  ) {
    super();
  }

  eq(other: TaskWidget) {
    return other.checked === this.checked && other.pos === this.pos;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("span");
    box.className = "cm-md-task";
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", this.checked ? "true" : "false");
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 3, insert: this.checked ? "[ ]" : "[x]" },
      });
    });
    return box;
  }

  ignoreEvent() {
    return true;
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const hr = document.createElement("hr");
    hr.className = "cm-md-hr";
    return hr;
  }

  ignoreEvent() {
    return true;
  }
}

function buildDecorations(view: EditorView): {
  decorations: DecorationSet;
  atomic: DecorationSet;
} {
  const { state } = view;
  const out: Range<Decoration>[] = [];

  // YAML frontmatter ("---" … "---" as the very first lines) renders as one
  // muted block, and nothing inside it gets live-preview decorations — in
  // particular its dashes must not become horizontal-rule widgets.
  let fmEnd = -1;
  if (state.doc.lines > 1 && state.doc.line(1).text.trim() === "---") {
    for (let l = 2; l <= Math.min(state.doc.lines, 100); l++) {
      const text = state.doc.line(l).text;
      if (text.trim() === "---" || text.trim() === "...") {
        fmEnd = state.doc.line(l).to;
        break;
      }
      if (text.trim() === "") break; // a blank line ends the preamble
    }
  }
  // Only replaced widgets must be atomic: the checkbox replaces its "[x]"
  // text, so there is nothing in the DOM to click or step through.
  // Collapsed syntax is deliberately NOT atomic — a click maps through the
  // live DOM onto the exact character, and the caret can never rest inside
  // collapsed text anyway, because any line it is on is active and shown
  // raw.
  const atomicOut: Range<Decoration>[] = [];

  // A line is "active" when any selection range touches it: raw syntax stays visible there.
  const lineActive = (pos: number) => {
    const line = state.doc.lineAt(pos);
    return state.selection.ranges.some((r) => r.from <= line.to && r.to >= line.from);
  };
  // Collapsed out of the layout entirely (Obsidian-style): headings sit
  // flush, bold reads clean — no blank holes where syntax was. Clicks on
  // the visible text still land on the exact character; the line then
  // reveals its raw markdown in place.
  const hidden = Decoration.replace({ class: "cm-md-hidden" });
  const hide = (from: number, to: number) => {
    out.push(hidden.range(from, to));
  };
  const mark = (cls: string, from: number, to: number) =>
    out.push(Decoration.mark({ class: cls }).range(from, to));
  const lineDeco = (cls: string, pos: number) =>
    out.push(Decoration.line({ class: cls }).range(pos));
  // Code spans the ==highlight== sweep must not touch.
  const codeSpans: [number, number][] = [];
  // Only decorate the visible viewport — the pattern the obsidian-cm6-attributes
  // reference plugin uses (view.visibleRanges, never the whole document).
  // Scrolling rebuilds via viewportChanged, so offscreen lines get decorated
  // just before they appear. Keeps every rebuild O(viewport), not O(document).
  let sliceLo = 0;
  let sliceHi = 0;
  const eachLine = (from: number, to: number, fn: (pos: number) => void) => {
    const first = state.doc.lineAt(Math.max(from, sliceLo)).number;
    const last = state.doc.lineAt(Math.min(to, sliceHi)).number;
    for (let l = first; l <= last; l++) fn(state.doc.line(l).from);
  };

  if (fmEnd > 0) {
    for (let l = 1; l <= state.doc.lineAt(fmEnd).number; l++) {
      lineDeco("cm-md-frontmatter", state.doc.line(l).from);
    }
  }

  // Label text of a link/image: between the first two LinkMarks. A link has
  // four of them ([, ], (, )) — lezer reuses LinkMark for images too (no
  // ImageMark node exists), and the label sits between [ and ].
  const labelRange = (node: SyntaxNodeRef) => {
    const marks = node.node.getChildren("LinkMark");
    if (marks.length >= 2) return { from: marks[0].to, to: marks[1].from };
    return { from: node.from, to: node.to };
  };

  // A destination CommonMark refused: a "(...)" group glued right after a
  // Link/Image whose parse produced no URL child (raw spaces make
  // "[note](My Note.md)" invalid, so the destination stays literal text and
  // the line would read "note(My Note.md)" forever). Returns the tail's
  // extent including the parens plus the destination text between them.
  const tailDestination = (from: number) => {
    if (state.doc.sliceString(from, from + 1) !== "(") return null;
    const line = state.doc.lineAt(from);
    const close = state.doc.sliceString(from, line.to).indexOf(")");
    if (close === -1) return null;
    return { from, to: from + close + 1, href: state.doc.sliceString(from + 1, from + close) };
  };

  const visitNode = (node: SyntaxNodeRef) => {
    switch (node.name) {
      case "ATXHeading1":
      case "ATXHeading2":
      case "ATXHeading3":
      case "ATXHeading4":
      case "ATXHeading5":
      case "ATXHeading6":
        lineDeco(`cm-md-heading cm-md-h${node.name.slice(-1)}`, node.from);
        break;
      case "SetextHeading1":
        lineDeco("cm-md-heading cm-md-h1", node.from);
        break;
      case "SetextHeading2":
        lineDeco("cm-md-heading cm-md-h2", node.from);
        break;

      case "HeaderMark": {
        if (lineActive(node.from)) break;
        // hide the hashes plus the space that follows them
        const line = state.doc.lineAt(node.from);
        let end = node.to;
        while (end < line.to && state.doc.sliceString(end, end + 1) === " ") end++;
        hide(node.from, end);
        break;
      }

      case "StrongEmphasis":
        mark("cm-md-strong", node.from, node.to);
        break;
      case "Emphasis":
        mark("cm-md-em", node.from, node.to);
        break;
      case "Strikethrough":
        mark("cm-md-strike", node.from, node.to);
        break;
      case "EmphasisMark":
      case "StrikethroughMark":
        if (!lineActive(node.from)) hide(node.from, node.to);
        break;

      case "InlineCode":
        mark("cm-md-inlinecode", node.from, node.to);
        break;
      case "CodeMark": {
        // backticks of inline code, or a fence line of a code block
        if (lineActive(node.from)) break;
        if (node.node.parent?.name === "FencedCode") {
          // whole fence line: clickable, so the cursor can rest on the
          // fence and unhide it
          hide(node.from, state.doc.lineAt(node.from).to);
        } else {
          hide(node.from, node.to);
        }
        break;
      }
      case "FencedCode":
        eachLine(node.from, node.to, (pos) => lineDeco("cm-md-codeblock", pos));
        codeSpans.push([node.from, node.to]);
        break;
      case "CodeBlock":
        // Indented code block: same look as fenced code.
        eachLine(node.from, node.to, (pos) => lineDeco("cm-md-codeblock", pos));
        codeSpans.push([node.from, node.to]);
        break;

      case "Link": {
        // Wikilink check first: "[[Note]]" parses as a plain Link wrapped in
        // extra brackets the markdown grammar leaves as anonymous text. Give
        // it the vault's wikilink look and hide the outer brackets, so the
        // editor shows what read mode shows.
        const opens = node.from > 0 && state.doc.sliceString(node.from - 1, node.from) === "[";
        const closes =
          node.to < state.doc.length && state.doc.sliceString(node.to, node.to + 1) === "]";
        if (opens && closes) {
          const inner = labelRange(node);
          if (inner.from < inner.to) {
            const title = state.doc.sliceString(inner.from, inner.to);
            out.push(
              Decoration.mark({
                class: "cm-md-wikilink",
                attributes: { "data-wikilink": title, title },
              }).range(inner.from, inner.to),
            );
          }
          if (!lineActive(node.from)) {
            hide(node.from - 1, node.from);
            hide(node.to, node.to + 1);
          }
          break;
        }
        // Style the label only: brackets, parens, url and "title" stay
        // transparent, so the underline never spans blank space.
        const url = node.node.getChild("URL");
        let href = url ? state.doc.sliceString(url.from, url.to) : "";
        // Recover a refused destination (see tailDestination): hide the
        // "(...)" tail like a URL on inactive lines and keep it as the
        // link's target, so Ctrl/Cmd-click still opens it.
        if (!url) {
          const tail = tailDestination(node.to);
          if (tail) {
            href = tail.href;
            if (!lineActive(node.from)) hide(tail.from, tail.to);
          }
        }
        const label = labelRange(node);
        if (label.from < label.to) {
          out.push(
            Decoration.mark({
              class: "cm-md-link",
              attributes: href ? { title: href, "data-href": href } : undefined,
            }).range(label.from, label.to),
          );
        }
        break;
      }
      case "Image": {
        const label = labelRange(node);
        const url = node.node.getChild("URL");
        let href = url ? state.doc.sliceString(url.from, url.to) : "";
        if (!url) {
          const tail = tailDestination(node.to);
          if (tail) {
            href = tail.href;
            if (!lineActive(node.from)) hide(tail.from, tail.to);
          }
        }
        if (label.from < label.to) {
          out.push(
            Decoration.mark({
              class: "cm-md-image",
              attributes: href ? { title: href, "data-href": href } : undefined,
            }).range(label.from, label.to),
          );
        }
        break;
      }
      case "LinkMark":
        if (!lineActive(node.from)) hide(node.from, node.to);
        break;
      case "URL":
        // The URL is target text only inside links, images and reference
        // definitions. Bare URLs and <autolinks> are the visible text
        // itself — hiding them would erase the link from the page.
        if (
          (node.node.parent?.name === "Link" ||
            node.node.parent?.name === "Image" ||
            node.node.parent?.name === "LinkReference") &&
          !lineActive(node.from)
        ) {
          hide(node.from, node.to);
        }
        break;
      case "LinkTitle":
      case "LinkLabel":
        // "Title" of [label](url "Title") and [ref] of [label][ref]. Labels
        // of reference *definitions* ([ref]: url) stay visible.
        if (node.node.parent?.name === "Link" && !lineActive(node.from)) {
          hide(node.from, node.to);
        }
        break;

      case "Blockquote":
        eachLine(node.from, node.to, (pos) => lineDeco("cm-md-quote", pos));
        break;
      case "QuoteMark": {
        if (lineActive(node.from)) break;
        // Swallow the spaces after ">" too, so the text sits flush.
        const line = state.doc.lineAt(node.from);
        let end = node.to;
        while (end < line.to && state.doc.sliceString(end, end + 1) === " ") end++;
        hide(node.from, end);
        break;
      }

      case "ListMark":
      case "TableDelimiter":
        mark("cm-md-syntax", node.from, node.to);
        break;

      case "TaskMarker": {
        // Always a widget, active line or not: the checkbox must not be
        // swapped for raw "[x]" when the line activates (that would shift
        // the text under a just-placed caret). Clicking toggles instead.
        const text = state.doc.sliceString(node.from, node.to);
        const range = Decoration.replace({
          widget: new TaskWidget(/[xX]/.test(text), node.from),
        }).range(node.from, node.to);
        out.push(range);
        atomicOut.push(range);
        break;
      }

      case "HorizontalRule":
        // not atomic: clicking the rule still activates the line and shows raw ---
        if (!lineActive(node.from)) {
          out.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to));
        }
        break;
    }
  };

  for (const { from: lo, to: hi } of view.visibleRanges) {
    sliceLo = lo;
    sliceHi = hi;
    try {
      // The parser works asynchronously; on jumps/scrolls the tree may not
      // cover the new viewport yet, and links or tasks would silently lose
      // their decorations until an unrelated update. Parse this viewport
      // synchronously (bounded budget) instead.
      const tree = ensureSyntaxTree(state, hi, 500) ?? syntaxTree(state);
      tree.iterate({
        from: lo,
        to: hi,
        enter: (node) => {
          if (fmEnd > 0 && node.from < fmEnd) return false; // inside frontmatter
          return visitNode(node);
        },
      });
      // Obsidian's ==highlight== is not markdown; sweep it per line inside
      // this viewport, away from code and frontmatter.
      eachLine(lo, hi, (pos) => {
        if (fmEnd > 0 && pos < fmEnd) return;
        if (codeSpans.some(([cf, ct]) => pos >= cf && pos < ct)) return;
        const { text } = state.doc.lineAt(pos);
        for (const m of text.matchAll(/==([^=\n]+)==/g)) {
          const from = pos + m.index;
          const to = from + m[0].length;
          mark("cm-md-highlight", from + 2, to - 2);
          if (!lineActive(from)) {
            hide(from, from + 2);
            hide(to - 2, to);
          }
        }
      });
    } catch (err) {
      // CM6 silently unloads crashing extensions — surface the failure instead.
      console.error("live-preview decorations failed", err);
      throw err;
    }
  }

  return {
    decorations: Decoration.set(out, true),
    atomic: Decoration.set(atomicOut, true),
  };
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomic: DecorationSet;

    constructor(view: EditorView) {
      const built = buildDecorations(view);
      this.decorations = built.decorations;
      this.atomic = built.atomic;
    }

    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        const built = buildDecorations(u.view);
        this.decorations = built.decorations;
        this.atomic = built.atomic;
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    // Only replaced widgets are atomic: there is no DOM inside a checkbox
    // to click or move through. Transparent syntax must stay clickable,
    // so the caret can land on the exact glyph and reveal its line.
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
  },
);

export const mdLivePreview: Extension = livePreviewPlugin;

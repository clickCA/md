import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { mdLivePreview } from "./live-preview";
import { corpus } from "./vault-corpus.generated";

/* Sweep the live preview over every file of a real Obsidian vault
   (regenerate with: node scripts/make-vault-corpus.mjs). The invariants:
   - decoration building never throws (CM6 would silently unload the
     plugin and every note would lose its live preview)
   - the document is never mutated by decorating
   - walking the cursor through the file keeps those two true
   - wikilinks and task checkboxes render wherever the source has them
     (CM6 only decorates the viewport, so each one is visited) */

function mount(content: string) {
  return new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [markdown({ base: markdownLanguage }), mdLivePreview()],
      selection: { anchor: content.length },
    }),
    parent: document.body,
  });
}

// The fixture is `as const`, which narrows length to a literal; widen it so
// skipIf stays meaningful when the fixture is absent (length 0).
const corpusSize: number = corpus.length;

describe("live preview over the real vault", () => {
  it.skipIf(corpusSize === 0)(`covers ${corpusSize} vault files`, () => {
    for (const { name, content } of corpus) {
      const errors: unknown[] = [];
      const orig = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args[0]);
        orig(...args);
      };
      let view: EditorView | null = null;
      try {
        view = mount(content);
        // Walk the cursor through the file — every position rebuilds
        // decorations and each rebuild must succeed.
        const lines = view.state.doc.lines;
        for (let l = 1; l <= lines; l += 5) {
          view.dispatch({ selection: { anchor: view.state.doc.line(l).from } });
        }
        expect(view.state.doc.toString(), `${name}: doc must not change`).toBe(content);
        expect(errors, `${name}: decoration build threw`).toEqual([]);

        // Wikilinks: visiting each one must show its note name in the DOM.
        for (const m of content.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
          view.dispatch({ selection: { anchor: m.index + 1 }, scrollIntoView: true });
          const wanted = m[1].split("|")[0].split("#")[0].trim();
          const rendered = Array.from(view.contentDOM.querySelectorAll("[data-wikilink]")).map(
            (el) => el.getAttribute("data-wikilink") ?? "",
          );
          if (!rendered.includes(wanted)) {
            throw new Error(`${name}: wikilink [[${m[1]}]] not rendered (got ${rendered})`);
          }
        }

        // Task markers: visiting each one must show its checkbox.
        for (const m of content.matchAll(/(^|\n)([ \t]*[-*+][ \t]+\[[ xX]\])/g)) {
          view.dispatch({
            selection: { anchor: m.index + m[1].length + 1 },
            scrollIntoView: true,
          });
          if (!view.contentDOM.querySelector('[role="checkbox"]')) {
            throw new Error(`${name}: task marker ${JSON.stringify(m[2])} has no checkbox`);
          }
        }
      } finally {
        view?.destroy();
        console.error = orig;
      }
    }
  });
});

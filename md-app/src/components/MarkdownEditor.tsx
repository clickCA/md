import { useEffect, useRef } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";

interface Props {
  path: string;
  initialBody: string;
  dark: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}

const themeCompartment = new Compartment();

const baseTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "15px", backgroundColor: "var(--bg)" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
    lineHeight: "1.7",
    padding: "16px 24px",
  },
  ".cm-gutters": { backgroundColor: "var(--bg)", border: "none", color: "var(--text-2)" },
  ".cm-activeLine": { backgroundColor: "var(--surface-2)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--surface-2)" },
  ".cm-content": { caretColor: "var(--accent)" },
  "&.cm-focused": { outline: "none" },
});

export default function MarkdownEditor({ path, initialBody, dark, onChange, onSave }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!hostRef.current) return;
    const extensions: Extension[] = [
      basicSetup,
      markdown(),
      baseTheme,
      themeCompartment.of(EditorView.darkTheme.of(dark)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            onSaveRef.current();
            return true;
          },
        },
      ]),
    ];
    const view = new EditorView({
      state: EditorState.create({ doc: initialBody, extensions }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // recreate only when switching notes; body updates go through dispatch below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.reconfigure(EditorView.darkTheme.of(dark)),
    });
  }, [dark]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== initialBody) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: initialBody } });
    }
  }, [initialBody]);

  return <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />;
}

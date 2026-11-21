import { EditorView } from "@codemirror/view";
import { render } from "vitest-browser-react";
import { MarkdownEditor } from "@/components/quire/NoteEditor";
import type { VaultFile } from "@/lib/vault";

/**
 * Shared render helpers for browser tests. They exist so component
 * changes ripple into one file instead of into every suite. DOM and
 * timing primitives live in `./dom`.
 */

/** The one CodeMirror instance on the page, failing loudly if none mounted. */
export function editorView(): EditorView {
  const el = document.querySelector(".cm-editor");
  if (!el) throw new Error("no .cm-editor mounted");
  return EditorView.findFromDOM(el as HTMLElement)!;
}

type EditorProps = Parameters<typeof MarkdownEditor>[0];

/**
 * Render MarkdownEditor with the house props filled in. Suites pass only
 * what they vary (`file`, `onChange`, `onOpenLink`, …), so a new editor
 * prop gets one default here instead of an edit in every suite.
 */
export async function renderEditor(
  overrides: Partial<EditorProps> & { file: VaultFile },
): Promise<ReturnType<typeof render>> {
  return render(
    <MarkdownEditor
      dir="/vault"
      onChange={() => {}}
      onCursor={() => {}}
      dark={false}
      {...overrides}
    />,
  );
}

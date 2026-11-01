import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { tableAt, tableKeymap } from "./table-editing";

function mount(source: string): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc: source,
      extensions: [markdown({ base: markdownLanguage }), keymap.of(tableKeymap)],
    }),
    parent: document.body,
  });
}

function place(view: EditorView, line: number, offset = 0) {
  const info = view.state.doc.line(line);
  view.dispatch({ selection: { anchor: info.from + offset } });
}

function press(view: EditorView, key: string, shift = false): KeyboardEvent {
  view.focus();
  const event = new KeyboardEvent("keydown", {
    key,
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

const table = ["| Name | Age |", "| --- | ---: |", "| Ada | 36 |"].join("\n");

describe("table keymap", () => {
  it("Tab moves to the next cell and aligns the table", () => {
    const view = mount(table);
    try {
      place(view, 3, 2); // inside "Ada"
      const event = press(view, "Tab");
      expect(event.defaultPrevented).toBe(true);

      expect(view.state.doc.toString()).toBe(
        ["| Name | Age |", "| ---- | --: |", "| Ada  |  36 |"].join("\n"),
      );
      const head = view.state.selection.main.head;
      expect(view.state.doc.lineAt(head).number).toBe(3);
      expect(view.state.doc.sliceString(head, head + 2)).toBe("36");
    } finally {
      view.destroy();
    }
  });

  it("Tab at the last cell appends a new row", () => {
    const view = mount(table);
    try {
      place(view, 3, 8); // inside "36", the last cell
      press(view, "Tab");

      expect(view.state.doc.lines).toBe(4);
      expect(view.state.doc.line(4).text).toBe("|      |     |");
      expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(4);
    } finally {
      view.destroy();
    }
  });

  it("Shift-Tab walks back across rows", () => {
    const view = mount(table);
    try {
      place(view, 3, 2); // first body cell
      press(view, "Tab", true);

      const head = view.state.selection.main.head;
      expect(view.state.doc.lineAt(head).number).toBe(1);
      expect(view.state.doc.sliceString(head, head + 3)).toBe("Age");
    } finally {
      view.destroy();
    }
  });

  it("Enter inserts a row below and keeps the column", () => {
    const view = mount(table);
    try {
      place(view, 3, 2); // Ada, first column
      const event = press(view, "Enter");
      expect(event.defaultPrevented).toBe(true);

      expect(view.state.doc.lines).toBe(4);
      expect(view.state.doc.line(4).text).toBe("|      |     |");
      const head = view.state.selection.main.head;
      expect(view.state.doc.lineAt(head).number).toBe(4);
    } finally {
      view.destroy();
    }
  });

  it("Enter on the header moves into the first body row", () => {
    const view = mount(table);
    try {
      place(view, 1, 2); // "Name"
      press(view, "Enter");

      expect(view.state.doc.toString()).toBe(
        ["| Name | Age |", "| ---- | --: |", "| Ada  |  36 |"].join("\n"),
      );
      const head = view.state.selection.main.head;
      expect(view.state.doc.lineAt(head).number).toBe(3);
      expect(view.state.doc.sliceString(head, head + 2)).toBe("Ad");
    } finally {
      view.destroy();
    }
  });

  it("Backspace removes an empty body row", () => {
    const view = mount(["| A | B |", "| --- | --- |", "|  |  |"].join("\n"));
    try {
      place(view, 3, 0);
      const event = press(view, "Backspace");
      expect(event.defaultPrevented).toBe(true);
      expect(view.state.doc.toString()).toBe(["| A | B |", "| --- | --- |"].join("\n"));
    } finally {
      view.destroy();
    }
  });

  it("leaves table-looking text inside a code fence alone", () => {
    const source = ["```md", "| a | b |", "| --- | --- |", "```"].join("\n");
    const view = mount(source);
    try {
      place(view, 2, 2);
      expect(tableAt(view)).toBeNull();
      const event = press(view, "Tab");
      expect(event.defaultPrevented).toBe(false);
      expect(view.state.doc.toString()).toBe(source);
    } finally {
      view.destroy();
    }
  });

  it("ignores Tab outside a table", () => {
    const view = mount("plain paragraph");
    try {
      place(view, 1, 2);
      const event = press(view, "Tab");
      expect(event.defaultPrevented).toBe(false);
      expect(view.state.doc.toString()).toBe("plain paragraph");
    } finally {
      view.destroy();
    }
  });
});

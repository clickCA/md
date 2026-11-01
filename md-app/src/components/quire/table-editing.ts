import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import type { EditorState } from "@codemirror/state";
import { type EditorView, type KeyBinding } from "@codemirror/view";
import {
  formatTable,
  parseTable,
  tableLayout,
  type TableInfo,
  type TableLayout,
} from "@/lib/table";

/* ── Table editing ─────────────────────────────────────────────────────
   Markdown tables are text, so CodeMirror's default Tab (indent) and
   Enter (new paragraph) actively fight the table structure: Tab inserts
   spaces instead of moving cells, and Enter splits a row. This keymap
   adds the interactions people expect from a table editor while keeping
   the document as plain, portable markdown:

   - Tab / Shift+Tab    move between cells, wrapping across rows
   - Enter              start the next row (or move into the first one)
   - Backspace          remove an empty body row
   - any move           re-aligns the columns

   Only keystrokes that land inside a parsed table are intercepted, and
   everything outside a table keeps the normal markdown keymap. */

type Located = { kind: "cell"; row: number; col: number } | { kind: "delimiter" };

function inCode(state: EditorState, pos: number): boolean {
  const tree = ensureSyntaxTree(state, pos, 50) ?? syntaxTree(state);
  const probe = Math.min(pos + 1, state.doc.length);
  for (let node: SyntaxNode | null = tree.resolveInner(probe, -1); node; node = node.parent) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") return true;
    if (node.name === "Table") return false;
  }
  return false;
}

/** The table under the main caret, or null when the caret is outside one. */
export function tableAt(view: EditorView): TableInfo | null {
  const head = view.state.selection.main.head;
  if (inCode(view.state, head)) return null;
  return parseTable(view.state.doc, head);
}

function locate(view: EditorView, table: TableInfo): Located | null {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos).number;
  if (line === table.delimiter.line) return { kind: "delimiter" };

  let row = -1;
  if (line === table.header.line) row = 0;
  else {
    const index = table.rows.findIndex((entry) => entry.line === line);
    if (index >= 0) row = index + 1;
  }
  if (row < 0) return null;

  const cells = row === 0 ? table.header.cells : table.rows[row - 1].cells;
  // A caret in the whitespace around a cell belongs to the following cell;
  // on a trailing pipe it belongs to the last cell.
  let col = cells.findIndex((cell) => pos >= cell.from && pos <= cell.to);
  if (col < 0) col = cells.findIndex((cell) => pos <= cell.to);
  if (col < 0) col = Math.max(0, cells.length - 1);
  return { kind: "cell", row, col };
}

/**
 * Replace the table with its canonical, aligned form and put the caret in
 * `row` (0 = header) / `col`. `insertBodyAt` adds a fresh empty row at that
 * body index first, which is how Tab-at-the-end and Enter grow a table.
 */
function jumpToCell(
  view: EditorView,
  table: TableInfo,
  row: number,
  col: number,
  insertBodyAt?: number,
): boolean {
  const layout: TableLayout = tableLayout(table);
  if (insertBodyAt !== undefined) {
    const width = Math.max(layout.aligns.length, table.columns);
    layout.body.splice(
      insertBodyAt,
      0,
      Array.from({ length: width }, () => ""),
    );
  }

  const formatted = formatTable(layout);
  const targetRow = formatted.rows[row];
  if (!targetRow) return false;
  const target = targetRow[Math.max(0, Math.min(col, targetRow.length - 1))];
  if (!target) return false;

  const anchor = table.from + target.contentStart;
  const current = view.state.doc.sliceString(table.from, table.to);
  view.dispatch({
    changes:
      current === formatted.text
        ? undefined
        : { from: table.from, to: table.to, insert: formatted.text },
    selection: { anchor },
    scrollIntoView: true,
    userEvent: "input.table",
  });
  return true;
}

function moveCell(view: EditorView, direction: 1 | -1): boolean {
  const table = tableAt(view);
  if (!table) return false;
  const located = locate(view, table);
  if (!located) return false;

  if (located.kind === "delimiter") {
    if (direction > 0) {
      return jumpToCell(view, table, 1, 0, table.rows.length === 0 ? 0 : undefined);
    }
    return jumpToCell(view, table, 0, table.columns - 1);
  }

  let { row, col } = located;
  if (direction > 0) {
    if (col + 1 < table.columns) {
      col++;
    } else if (row < table.rows.length) {
      // There is another body row below (row 1 is body row 0).
      row++;
      col = 0;
    } else {
      // Last cell of the last row: grow the table.
      return jumpToCell(view, table, row + 1, 0, row);
    }
  } else if (col > 0) {
    col--;
  } else if (row > 0) {
    row--;
    col = table.columns - 1;
  } else {
    return false;
  }

  return jumpToCell(view, table, row, col);
}

function enterTable(view: EditorView): boolean {
  if (!view.state.selection.main.empty) return false;
  const table = tableAt(view);
  if (!table) return false;
  const located = locate(view, table);
  if (!located) return false;

  if (located.kind === "delimiter") {
    return jumpToCell(view, table, 1, 0, table.rows.length === 0 ? 0 : undefined);
  }

  // Enter on the header moves into the first body row, creating one if the
  // table has no body yet. The delimiter must stay directly below the header.
  if (located.row === 0) {
    return jumpToCell(view, table, 1, located.col, table.rows.length === 0 ? 0 : undefined);
  }

  // Body rows: insert a row below the current one and keep the column.
  return jumpToCell(view, table, located.row + 1, located.col, located.row);
}

function deleteEmptyRow(view: EditorView): boolean {
  const table = tableAt(view);
  if (!table) return false;
  const located = locate(view, table);
  if (!located || located.kind !== "cell" || located.row === 0) return false;

  const row = table.rows[located.row - 1];
  if (!row || row.cells.some((cell) => cell.text.trim() !== "")) return false;

  const head = view.state.selection.main.head;
  const first = row.cells[0]?.from ?? row.to;
  if (head > first) return false;

  // Remove the newline before the row plus the row itself.
  const from = view.state.doc.line(row.line - 1).to;
  view.dispatch({
    changes: { from, to: row.to },
    selection: { anchor: from },
    userEvent: "delete.table-row",
  });
  return true;
}

export const tableKeymap: KeyBinding[] = [
  { key: "Tab", run: (view) => moveCell(view, 1) },
  { key: "Shift-Tab", run: (view) => moveCell(view, -1) },
  { key: "Enter", run: enterTable },
  { key: "Backspace", run: deleteEmptyRow },
];

import type { Text } from "@codemirror/state";

/* ── Markdown table geometry ───────────────────────────────────────────
   Pure helpers shared by the live editor's table keymap and its tests.
   Everything works on absolute document offsets so a caller can jump the
   caret straight into a cell, and formatting rebuilds the whole block with
   aligned columns without touching the document's newline style. */

export type TableAlign = "left" | "center" | "right" | null;

export type TableCell = {
  /** First content character (surrounding whitespace excluded). */
  from: number;
  /** One past the last content character. */
  to: number;
  text: string;
};

export type TableRow = {
  /** 1-based document line. */
  line: number;
  from: number;
  to: number;
  cells: TableCell[];
};

export type TableInfo = {
  /** First character of the header line (including any blockquote prefix). */
  from: number;
  /** One past the last character of the final row. */
  to: number;
  startLine: number;
  endLine: number;
  /** Blockquote marker copied onto every formatted line (`"> "`), or "". */
  prefix: string;
  header: TableRow;
  delimiter: { line: number; from: number; to: number; aligns: TableAlign[] };
  rows: TableRow[];
  columns: number;
  aligns: TableAlign[];
};

/** Alignment and cell text, with the syntactic ranges stripped. */
export type TableLayout = {
  prefix: string;
  aligns: TableAlign[];
  header: string[];
  body: string[][];
};

export type FormattedCell = {
  /** Offset of the padded cell inside the formatted block. */
  start: number;
  /** Offset where the cell's text begins (after alignment padding). */
  contentStart: number;
};

export type FormattedTable = {
  text: string;
  /** Header first, then body rows. The delimiter line is not included. */
  rows: FormattedCell[][];
};

const BLOCK_PREFIX = /^[ \t]*(?:>[ \t]*)+/;
const DELIMITER_CELL = /^:?-+:?$/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const BLOCKQUOTE = /^ {0,3}>/;
const BULLET_LIST = /^ {0,3}[-+*](?:[ \t]|$)/;
const ORDERED_LIST = /^ {0,3}\d{1,9}[.)](?:[ \t]|$)/;
const FENCED_CODE = /^ {0,3}(?:`{3,}|~{3,})/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/;
const SETEXT_UNDERLINE = /^ {0,3}[=-]+[ \t]*$/;
const HTML_BLOCK =
  /^ {0,3}(?:<!--|<\?|<!\[CDATA\[|<![A-Za-z]|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|pre|script|search|section|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul)(?:[ \t>]|$))/i;

function blockPrefix(text: string): string {
  return BLOCK_PREFIX.exec(text)?.[0] ?? "";
}

/** A line that starts a new CommonMark block and therefore ends a table. */
function startsBlock(text: string): boolean {
  return (
    ATX_HEADING.test(text) ||
    BLOCKQUOTE.test(text) ||
    BULLET_LIST.test(text) ||
    ORDERED_LIST.test(text) ||
    FENCED_CODE.test(text) ||
    THEMATIC_BREAK.test(text) ||
    HTML_BLOCK.test(text)
  );
}

/** `---` / `===` after a paragraph turns it into a setext heading, so the
 *  whole block is not a table at all. */
function isSetextUnderline(text: string): boolean {
  return SETEXT_UNDERLINE.test(text) && !pipePositions(text).length;
}

function isBlank(text: string): boolean {
  // A quoted blank line (">") also ends a table inside a blockquote.
  return text.trim() === "" || /^[ \t]*(?:>[ \t]*)+$/.test(text);
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

function pipePositions(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "|" && !isEscaped(text, i)) out.push(i);
  }
  return out;
}

/** Cell content ranges inside one row, trimmed and relative to the row. */
function splitCells(text: string): Array<{ from: number; to: number }> {
  const pipes = pipePositions(text);
  const segments: Array<[number, number]> = [];
  let start = 0;
  for (const pipe of pipes) {
    segments.push([start, pipe]);
    start = pipe + 1;
  }
  segments.push([start, text.length]);

  if (pipes.length > 0) {
    // A leading pipe is a boundary, not an empty first cell.
    if (text.slice(segments[0][0], segments[0][1]).trim() === "") segments.shift();
    // Same for a trailing pipe (or trailing whitespace after it).
    const last = segments[segments.length - 1];
    if (segments.length > 0 && text.slice(last[0], last[1]).trim() === "") segments.pop();
  }

  return segments.map(([from, to]) => {
    while (from < to && /\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to - 1])) to--;
    return { from, to };
  });
}

/** `:--`, `--:`, `:-:` and `---` cells → alignment. */
export function parseDelimiter(text: string): TableAlign[] | null {
  const cells = splitCells(text);
  if (cells.length === 0) return null;
  const aligns: TableAlign[] = [];
  for (const cell of cells) {
    const marker = text.slice(cell.from, cell.to);
    if (!DELIMITER_CELL.test(marker)) return null;
    const left = marker.startsWith(":");
    const right = marker.endsWith(":");
    aligns.push(left && right ? "center" : left ? "left" : right ? "right" : null);
  }
  return aligns;
}

function rowAt(doc: Text, lineNumber: number, prefix: string): TableRow {
  const line = doc.line(lineNumber);
  const content = line.text.slice(prefix.length);
  const cells = splitCells(content).map(({ from, to }) => ({
    from: line.from + prefix.length + from,
    to: line.from + prefix.length + to,
    text: content.slice(from, to),
  }));
  return { line: lineNumber, from: line.from, to: line.to, cells };
}

/**
 * Find the table containing `pos`, if any. Detection is line based (not
 * syntax-tree based) so it also works on the frame where a table was just
 * typed and the incremental parser has not caught up yet.
 */
export function parseTable(doc: Text, pos: number): TableInfo | null {
  if (pos < 0 || pos > doc.length) return null;
  const posLine = doc.lineAt(pos).number;

  const candidate = (delimiterLine: number): TableInfo | null => {
    if (delimiterLine < 2 || delimiterLine > doc.lines) return null;
    const delimiterText = doc.line(delimiterLine).text;
    const prefix = blockPrefix(delimiterText);
    const delimiterContent = delimiterText.slice(prefix.length);
    // A GFM delimiter row always contains at least one pipe; a bare `---` is
    // a setext underline (or thematic break), not a table.
    if (pipePositions(delimiterContent).length === 0) return null;
    const aligns = parseDelimiter(delimiterContent);
    if (!aligns) return null;

    const headerText = doc.line(delimiterLine - 1).text;
    if (blockPrefix(headerText) !== prefix) return null;
    const headerContent = headerText.slice(prefix.length);
    if (pipePositions(headerContent).length === 0) return null;
    // Four spaces make the line an indented code block, not a table header.
    if (/^(?: {4}|\t)/.test(headerContent)) return null;
    if (startsBlock(headerContent) || isSetextUnderline(headerContent)) return null;

    const header = rowAt(doc, delimiterLine - 1, prefix);
    if (header.cells.length !== aligns.length) return null;

    const rows: TableRow[] = [];
    let endLine = delimiterLine;
    for (let lineNumber = delimiterLine + 1; lineNumber <= doc.lines; lineNumber++) {
      const text = doc.line(lineNumber).text;
      if (isBlank(text) || !text.startsWith(prefix)) break;
      const content = text.slice(prefix.length);
      // A setext underline retroactively makes the whole block a heading, so
      // there is no table to edit or format here.
      if (isSetextUnderline(content)) return null;
      if (startsBlock(content)) break;
      rows.push(rowAt(doc, lineNumber, prefix));
      endLine = lineNumber;
    }

    if (posLine < delimiterLine - 1 || posLine > endLine) return null;

    const columns = Math.max(
      aligns.length,
      header.cells.length,
      ...rows.map((row) => row.cells.length),
    );
    const allAligns = Array.from({ length: columns }, (_, i) => aligns[i] ?? null);
    return {
      from: doc.line(delimiterLine - 1).from,
      to: doc.line(endLine).to,
      startLine: delimiterLine - 1,
      endLine,
      prefix,
      header,
      delimiter: {
        line: delimiterLine,
        from: doc.line(delimiterLine).from,
        to: doc.line(delimiterLine).to,
        aligns,
      },
      rows,
      columns,
      aligns: allAligns,
    };
  };

  // Cursor on the header: the delimiter is the very next line.
  if (posLine < doc.lines) {
    const below = candidate(posLine + 1);
    if (below) return below;
  }

  // Cursor on the delimiter or a body row: walk up to the delimiter.
  for (let lineNumber = posLine; lineNumber >= 2; lineNumber--) {
    const text = doc.line(lineNumber).text;
    if (lineNumber !== posLine && isBlank(text)) break;
    const found = candidate(lineNumber);
    if (found) return found;
    if (isBlank(text)) break;
  }
  return null;
}

export function tableLayout(table: TableInfo): TableLayout {
  return {
    prefix: table.prefix,
    aligns: [...table.aligns],
    header: table.header.cells.map((cell) => cell.text),
    body: table.rows.map((row) => row.cells.map((cell) => cell.text)),
  };
}

function pad(text: string, width: number, align: TableAlign): string {
  const space = Math.max(0, width - text.length);
  if (align === "right") return " ".repeat(space) + text;
  if (align === "center") {
    const left = Math.floor(space / 2);
    return " ".repeat(left) + text + " ".repeat(space - left);
  }
  return text + " ".repeat(space);
}

function leftPadding(length: number, width: number, align: TableAlign): number {
  const space = Math.max(0, width - length);
  if (align === "right") return space;
  if (align === "center") return Math.floor(space / 2);
  return 0;
}

function delimiterCell(width: number, align: TableAlign): string {
  if (align === "left") return ":" + "-".repeat(Math.max(1, width - 1));
  if (align === "right") return "-".repeat(Math.max(1, width - 1)) + ":";
  if (align === "center") {
    return ":" + "-".repeat(Math.max(1, width - 2)) + ":";
  }
  return "-".repeat(width);
}

/**
 * Render a table with padded, aligned columns. The result is deliberately
 * canonical (`| a | b |` on every line) so repeated formats are idempotent.
 */
export function formatTable(layout: TableLayout): FormattedTable {
  const columns = Math.max(
    layout.aligns.length,
    layout.header.length,
    ...layout.body.map((row) => row.length),
  );
  const aligns = Array.from({ length: columns }, (_, i) => layout.aligns[i] ?? null);
  const rawRows = [layout.header, ...layout.body];
  const widths = Array.from({ length: columns }, (_, col) => {
    let width = 3;
    for (const row of rawRows) width = Math.max(width, row[col]?.length ?? 0);
    return width;
  });

  const renderRow = (cells: string[]) => {
    let text = layout.prefix + "|";
    const rendered: Array<{ start: number; contentStart: number }> = [];
    for (let col = 0; col < columns; col++) {
      text += " ";
      const raw = cells[col] ?? "";
      const padded = pad(raw, widths[col], aligns[col]);
      const start = text.length;
      text += padded;
      rendered.push({
        start,
        contentStart: start + leftPadding(raw.length, widths[col], aligns[col]),
      });
      text += " |";
    }
    return { text, cells: rendered };
  };

  const lines: string[] = [];
  const rowCells: FormattedCell[][] = [];
  const header = renderRow(layout.header);
  lines.push(header.text);
  rowCells.push(header.cells);

  lines.push(
    layout.prefix +
      "| " +
      widths.map((width, col) => delimiterCell(width, aligns[col])).join(" | ") +
      " |",
  );

  for (const row of layout.body) {
    const rendered = renderRow(row);
    lines.push(rendered.text);
    rowCells.push(rendered.cells);
  }

  // Convert line-relative cell offsets into block-relative offsets.
  const text = lines.join("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  // Output row order mirrors lines: header, delimiter, body…
  const rows = rowCells.map((cells, index) => {
    const lineStart = lineStarts[index === 0 ? 0 : index + 1];
    return cells.map((cell) => ({
      start: lineStart + cell.start,
      contentStart: lineStart + cell.contentStart,
    }));
  });

  return { text, rows };
}

import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { formatTable, parseDelimiter, parseTable, tableLayout } from "./table";

function doc(source: string): Text {
  return Text.of(source.split("\n"));
}

describe("parseDelimiter", () => {
  it("recognises alignment markers", () => {
    expect(parseDelimiter("| --- | :-- | --: | :-: |")).toEqual([null, "left", "right", "center"]);
  });

  it("rejects non-delimiter rows", () => {
    expect(parseDelimiter("| Name | Age |")).toBeNull();
    expect(parseDelimiter("| -- x | --- |")).toBeNull();
  });
});

describe("parseTable", () => {
  const source = ["intro", "", "| Name | Age |", "| --- | ---: |", "| Ada | 36 |"].join("\n");

  it("finds the table around a header, delimiter, or body caret", () => {
    const text = doc(source);
    for (const line of [3, 4, 5]) {
      const table = parseTable(text, text.line(line).from + 1);
      expect(table, `line ${line}`).not.toBeNull();
      expect(table?.startLine).toBe(3);
      expect(table?.endLine).toBe(5);
      expect(table?.columns).toBe(2);
      expect(table?.aligns).toEqual([null, "right"]);
    }
  });

  it("exposes trimmed cell ranges", () => {
    const text = doc(source);
    const table = parseTable(text, text.line(5).from);
    expect(table?.header.cells.map((cell) => cell.text)).toEqual(["Name", "Age"]);
    expect(table?.rows[0].cells.map((cell) => cell.text)).toEqual(["Ada", "36"]);
    expect(text.sliceString(table!.header.cells[0].from, table!.header.cells[0].to)).toBe("Name");
  });

  it("does not split on escaped pipes", () => {
    const text = doc(["| a \\| b | c |", "| --- | --- |", "| d | e |"].join("\n"));
    const table = parseTable(text, 0);
    expect(table?.columns).toBe(2);
    expect(table?.header.cells[0].text).toBe("a \\| b");
  });

  it("supports tables inside blockquotes", () => {
    const text = doc(["> | a | b |", "> | --- | --- |", "> | c | d |"].join("\n"));
    const table = parseTable(text, text.line(3).from + 3);
    expect(table?.prefix).toBe("> ");
    expect(table?.header.cells.map((cell) => cell.text)).toEqual(["a", "b"]);
  });

  it("stops the table at the next block-level construct", () => {
    for (const tail of ["# Heading", "- item", "1. item", "> quote", "```", "***", "<div>"]) {
      const text = doc(["| a | b |", "| --- | --- |", "| c | d |", tail].join("\n"));
      const table = parseTable(text, text.line(3).from);
      expect(table?.endLine, tail).toBe(3);
    }
  });

  it("treats a following setext underline as a heading, not a table", () => {
    const text = doc(["| a | b |", "| --- | --- |", "| c | d |", "---"].join("\n"));
    expect(parseTable(text, text.line(3).from)).toBeNull();
  });

  it("ignores text that only resembles a table", () => {
    expect(parseTable(doc("| a | b |\nnot a delimiter\n| c | d |"), 0)).toBeNull();
    expect(parseTable(doc("| a | b |\n| --- |\n| c | d |"), 0)).toBeNull();
    expect(parseTable(doc("| a |\n---\n| c |"), 0)).toBeNull();
    expect(parseTable(doc("    | a | b |\n| --- | --- |\n| c | d |"), 0)).toBeNull();
  });
});

describe("formatTable", () => {
  it("pads columns and preserves alignment", () => {
    const formatted = formatTable({
      prefix: "",
      aligns: [null, "right"],
      header: ["Name", "Age"],
      body: [
        ["Ada", "36"],
        ["Grace Hopper", "1"],
      ],
    });

    expect(formatted.text).toBe(
      [
        "| Name         | Age |",
        "| ------------ | --: |",
        "| Ada          |  36 |",
        "| Grace Hopper |   1 |",
      ].join("\n"),
    );
  });

  it("puts the caret offset on the cell text, not its alignment padding", () => {
    const formatted = formatTable({
      prefix: "",
      aligns: ["right"],
      header: ["n"],
      body: [["1"]],
    });
    // Width is 3 ("---"), so "1" sits after two pad spaces on its row.
    const bodyCell = formatted.rows[1][0];
    expect(formatted.text.slice(bodyCell.contentStart, bodyCell.contentStart + 1)).toBe("1");
  });

  it("is idempotent once parsed again", () => {
    const text = doc(["| A | B |", "| :-: | --: |", "| x | longer |", "| y | z |"].join("\n"));
    const table = parseTable(text, 0)!;
    const once = formatTable(tableLayout(table)).text;
    const twice = formatTable(tableLayout(parseTable(doc(once), 0)!)).text;
    expect(twice).toBe(once);
  });
});

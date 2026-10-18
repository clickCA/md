export type BlockKind = "heading" | "list" | "code" | "table" | "quote" | "rule" | "paragraph";

export type Block = { start: number; end: number; kind: BlockKind };

export type EditorHandle = { jumpTo: (line: number) => void };

const listRe = /^\s*([-*+]|\d+[.)])\s/;
const listPrefixRe = /^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;
const fenceRe = /^\s*(```|~~~)/;
const headingRe = /^(#{1,6})\s/;
const ruleRe = /^\s*([-*_])(\s*\1){2,}\s*$/;

export function kindOf(line: string): BlockKind {
  if (fenceRe.test(line)) return "code";
  if (headingRe.test(line)) return "heading";
  if (ruleRe.test(line)) return "rule";
  if (listRe.test(line)) return "list";
  if (line.trimStart().startsWith("|")) return "table";
  if (line.trimStart().startsWith(">")) return "quote";
  return "paragraph";
}

export function headingLevel(line: string) {
  return line.match(headingRe)?.[1].length ?? 0;
}

/** Splits lines [from, to) into editable blocks. Blank lines separate blocks and are not part of any. */
export function parseBlocks(lines: string[], from = 0, to = lines.length): Block[] {
  const blocks: Block[] = [];
  let i = from;
  while (i < to) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const kind = kindOf(line);
    let j = i + 1;
    if (kind === "code") {
      const fence = line.trim().slice(0, 3);
      while (j < to && !lines[j].trim().startsWith(fence)) j++;
      j = Math.min(j + 1, to);
    } else if (kind === "table" || kind === "quote" || kind === "paragraph") {
      while (j < to && lines[j].trim() && kindOf(lines[j]) === kind) j++;
    } else if (kind === "list") {
      while (j < to && /^\s{2,}\S/.test(lines[j]) && !listRe.test(lines[j])) j++;
    }
    blocks.push({ start: i, end: j, kind });
    i = j;
  }
  return blocks;
}

export function blockAt(lines: string[], line: number): Block {
  const found = parseBlocks(lines).find((b) => line >= b.start && line < b.end);
  return found ?? { start: line, end: line + 1, kind: "paragraph" };
}

export function findContentLine(lines: string[], from: number, dir: 1 | -1) {
  for (let i = from; i >= 0 && i < lines.length; i += dir) {
    if (lines[i].trim()) return i;
  }
  return -1;
}

export function listPrefix(line: string) {
  const m = line.match(listPrefixRe);
  if (!m) return null;
  const marker = m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2];
  return { full: m[0], next: `${m[1]}${marker}${m[5]}${m[6] ? "[ ] " : ""}` };
}

export function toggleTask(lines: string[], index: number) {
  const next = [...lines];
  next[index] = next[index].replace(
    /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/,
    (_, p: string, c: string) => `${p}[${c === " " ? "x" : " "}]`,
  );
  return next;
}

import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import type { VaultFile } from "@/lib/vault";
import { MarkdownPreview } from "./note-preview";

const noop = () => {};

const file: VaultFile = {
  path: "Notes/Snippets.md",
  content: [
    "# Snippets",
    "",
    "Inline `code` stays as is.",
    "",
    "```rust",
    'const NAME: &str = "md"; // vault',
    "```",
    "",
    "```notareallanguage",
    "plain block",
    "```",
    "",
  ].join("\n"),
  committed: null,
};

async function renderPreview() {
  await render(
    <MarkdownPreview file={file} dir="/tmp/vault" onOpenLink={noop} onToggleTask={noop} />,
  );
  // Wait for the document to mount before poking at the DOM directly. (The
  // note name appears twice — inline title + the rendered `# Snippets`
  // heading — so wait on unique body text instead.)
  await expect.element(page.getByText("plain block")).toBeInTheDocument();
}

describe("MarkdownPreview code highlighting", () => {
  it("applies language tokens to fenced code blocks", async () => {
    await renderPreview();

    const code = document.querySelector("pre code.language-rust");
    expect(code).toBeTruthy();
    // rehype-highlight marked the block with its language and tokenized it
    expect(code!.className).toContain("hljs");
    expect(code!.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(code!.querySelector(".hljs-string")?.textContent).toBe('"md"');
    expect(code!.querySelector(".hljs-comment")?.textContent).toContain("vault");
  });

  it("renders unknown fence languages as plain code", async () => {
    await renderPreview();

    const plain = document.querySelector("pre code.language-notareallanguage");
    expect(plain).toBeTruthy();
    expect(plain!.textContent).toContain("plain block");
    expect(plain!.querySelector(".hljs-keyword")).toBeNull();
  });

  it("leaves inline code untokenized", async () => {
    await renderPreview();

    const inline = [...document.querySelectorAll("p code")].find((el) =>
      el.textContent?.includes("code"),
    );
    expect(inline).toBeTruthy();
    expect(inline!.className).not.toContain("hljs");
  });
});

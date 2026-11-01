import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { invoke } from "@tauri-apps/api/core";
import type { VaultFile } from "@/lib/vault";
import { MarkdownPreview } from "./note-preview";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const noop = () => {};

const file: VaultFile = {
  path: "Welcome.md",
  content: "# Hi\n\nSome **bold** and [[Other Note]].\n\n- [ ] task one\n- [x] task two\n",
  committed: null,
};

function renderPreview(overrides?: Partial<Parameters<typeof MarkdownPreview>[0]>) {
  return render(
    <MarkdownPreview
      file={file}
      dir="/vault"
      onOpenLink={noop}
      onToggleTask={noop}
      {...overrides}
    />,
  );
}

describe("MarkdownPreview", () => {
  it("renders headings, emphasis and task checkboxes", async () => {
    await renderPreview();
    await expect.element(page.getByRole("heading", { name: "Hi" })).toBeInTheDocument();
    await expect.element(page.getByRole("checkbox", { name: "task one" })).toBeInTheDocument();
    await expect
      .element(page.getByRole("checkbox", { name: "task two" }))
      .toHaveAttribute("checked", "");
  });

  it("renders wikilinks as buttons that open the linked note", async () => {
    const onOpenLink = vi.fn();
    await renderPreview({ onOpenLink });
    await page.getByRole("button", { name: "Other Note" }).click();
    expect(onOpenLink).toHaveBeenCalledWith("Other Note");
  });

  it("reports the source line of a clicked task checkbox", async () => {
    const onToggleTask = vi.fn();
    await renderPreview({ onToggleTask });
    await page.getByRole("checkbox", { name: "task one" }).click();
    expect(onToggleTask).toHaveBeenCalledWith(4); // "- [ ] task one" is on line 5
  });

  it("opens relative markdown links in the note they point at", async () => {
    const onOpenLink = vi.fn();
    await renderPreview({
      file: { ...file, content: "See [the docs](notes/docs.md) please.\n" },
      onOpenLink,
    });
    await page.getByRole("link", { name: "the docs" }).click();
    expect(onOpenLink).toHaveBeenCalledWith("notes/docs.md");
  });
});

describe("MarkdownPreview images", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("renders vault images as data URLs, decoding %20 paths", async () => {
    vi.mocked(invoke).mockResolvedValue("QUJD");
    await renderPreview({
      file: { ...file, content: "![shot](Images/Pasted%20image%201.png)\n" },
    });
    await expect.element(page.getByRole("img")).toBeInTheDocument();
    const img = document.querySelector(".prose-note img");
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,QUJD");
    expect(invoke).toHaveBeenCalledWith("read_file_bytes", {
      dir: "/vault",
      path: "Images/Pasted image 1.png",
    });
  });

  it("shows a muted label instead of a missing image file", async () => {
    vi.mocked(invoke).mockRejectedValue({ code: "io", message: "nope" });
    await renderPreview({
      file: { ...file, content: "![shot](Images/Gone%20away.png)\n" },
    });
    const missing = document.querySelector(".prose-note .md-image-missing");
    expect(missing?.textContent).toBe("Gone away.png");
  });

  it("renders remote images without touching the vault", async () => {
    await renderPreview({
      file: { ...file, content: "![shot](https://example.com/a.png)\n" },
    });
    await expect.element(page.getByRole("img")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });
});

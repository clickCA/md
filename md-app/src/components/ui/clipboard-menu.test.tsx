import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import ClipboardMenu from "./ClipboardMenu";

/* Clipboard plugin is mocked: tests run outside Tauri, so IPC would fail.
   execCommand is stubbed to false — in a real engine the execCommand path
   wins when user activation exists; stubbing it makes the plugin fallback
   deterministic here. */
const { writeText, readText } = vi.hoisted(() => ({
  writeText: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
  readText: vi.fn<() => Promise<string>>().mockResolvedValue("clipboard text"),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText, readText }));

const contextMenu = (el: Element, x = 10, y = 10) =>
  el.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: x,
      clientY: y,
    }),
  );

const item = (label: string) => page.getByRole("menuitem", { name: label });

beforeEach(() => {
  writeText.mockClear();
  readText.mockClear();
  document.getSelection()?.removeAllRanges();
  vi.spyOn(document, "execCommand").mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ClipboardMenu", () => {
  it("opens on an editable target and pastes the clipboard at the caret", async () => {
    await render(
      <div>
        <textarea defaultValue="hello world" aria-label="note body" />
        <ClipboardMenu />
      </div>,
    );
    const el = page.getByRole("textbox", { name: "note body" }).element() as HTMLTextAreaElement;
    el.setSelectionRange(11, 11); // caret at the end
    contextMenu(el);

    await expect.element(item("Paste")).toBeEnabled();
    await item("Paste").click();

    expect(readText).toHaveBeenCalled();
    expect(el.value).toBe("hello worldclipboard text");
  });

  it("copies a textarea selection through the plugin fallback", async () => {
    await render(
      <div>
        <textarea defaultValue="hello world" aria-label="note body" />
        <ClipboardMenu />
      </div>,
    );
    const el = page.getByRole("textbox", { name: "note body" }).element() as HTMLTextAreaElement;
    el.setSelectionRange(0, 5);
    contextMenu(el);

    await expect.element(item("Cut")).toBeEnabled();
    await item("Copy").click();
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(el.value).toBe("hello world"); // copy never mutates the target
  });

  it("offers only Copy for a static selection outside editable surfaces", async () => {
    await render(
      <div>
        <p>rendered preview text</p>
        <ClipboardMenu />
      </div>,
    );
    const p = page.getByText("rendered preview text").element();
    const range = document.createRange();
    range.selectNodeContents(p);
    document.getSelection()?.addRange(range);
    contextMenu(p);

    await expect.element(item("Copy")).toBeEnabled();
    await expect.element(item("Cut")).toBeDisabled();
    await expect.element(item("Paste")).toBeDisabled();
    await expect.element(item("Select All")).toBeDisabled();

    await item("Copy").click();
    expect(writeText).toHaveBeenCalledWith("rendered preview text");
  });

  it("stays suppressed on non-editable targets without a selection", async () => {
    await render(
      <div>
        <p>plain chrome</p>
        <ClipboardMenu />
      </div>,
    );
    contextMenu(page.getByText("plain chrome").element());
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  });

  it("never stacks on top of an already-claimed context menu (FileTree)", async () => {
    await render(
      <div>
        <textarea aria-label="note body" />
        <ClipboardMenu />
      </div>,
    );
    const el = page.getByRole("textbox", { name: "note body" }).element();
    // Base UI's ContextMenu.Trigger preventDefaults the event it claims.
    const claimed = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    claimed.preventDefault();
    el.dispatchEvent(claimed);
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape and hands focus back to the editable target", async () => {
    await render(
      <div>
        <textarea aria-label="note body" />
        <ClipboardMenu />
      </div>,
    );
    const el = page.getByRole("textbox", { name: "note body" }).element() as HTMLTextAreaElement;
    contextMenu(el);
    await expect.element(item("Paste")).toBeInTheDocument();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(el);
  });

  it("shows no enabled action for an empty editable target", async () => {
    await render(
      <div>
        <input aria-label="remote" />
        <ClipboardMenu />
      </div>,
    );
    const el = page.getByRole("textbox", { name: "remote" }).element();
    contextMenu(el);
    await expect.element(item("Paste")).toBeEnabled();
    await expect.element(item("Select All")).toBeEnabled();
    await expect.element(item("Cut")).toBeDisabled();
    await expect.element(item("Copy")).toBeDisabled();
  });

  it("renders the same four items in a fixed order", async () => {
    await render(
      <div>
        <textarea defaultValue="hello world" aria-label="note body" />
        <ClipboardMenu />
      </div>,
    );
    const el = page.getByRole("textbox", { name: "note body" }).element() as HTMLTextAreaElement;
    el.setSelectionRange(0, 5);
    contextMenu(el);
    await expect.element(page.getByRole("menu", { name: "Clipboard" })).toBeInTheDocument();
    const labels = Array.from(page.getByRole("menu").element().querySelectorAll("button")).map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(["Cut", "Copy", "Paste", "Select All"]);
  });
});

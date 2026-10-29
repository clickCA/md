import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import "@/index.css";
import { ImageViewer } from "./image-viewer";

/* 1×1 red PNG — data URLs pass through resolveImage without touching Tauri */
const RED_DOT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const BLUE_DOT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYPhfDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const IMAGES = [
  { src: RED_DOT, alt: "first image" },
  { src: BLUE_DOT, alt: "second image" },
];

const noop = () => {};

describe("ImageViewer", () => {
  it("renders the active image with its label", async () => {
    await render(<ImageViewer dir="/v" images={IMAGES} index={0} onNavigate={noop} onClose={noop} />);
    const dialog = page.getByRole("dialog", { name: "Image viewer" });
    await expect.element(dialog).toBeInTheDocument();
    await expect.element(page.getByText("first image")).toBeInTheDocument();
    await expect.element(page.getByAltText("first image")).toBeInTheDocument();
  });

  it("hides gallery controls for a single image", async () => {
    await render(
      <ImageViewer
        dir="/v"
        images={[IMAGES[0]]}
        index={0}
        onNavigate={noop}
        onClose={noop}
      />,
    );
    await expect.element(page.getByRole("button", { name: "Previous image" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Next image" })).not.toBeInTheDocument();
  });

  it("navigates the gallery via next/previous controls", async () => {
    const onNavigate = vi.fn();
    await render(
      <ImageViewer dir="/v" images={IMAGES} index={0} onNavigate={onNavigate} onClose={noop} />,
    );
    await expect.element(page.getByText("1 / 2")).toBeInTheDocument();
    await page.getByRole("button", { name: "Next image" }).click();
    expect(onNavigate).toHaveBeenCalledWith(1);
  });

  it("jumps to an image via its thumbnail", async () => {
    const onNavigate = vi.fn();
    await render(
      <ImageViewer dir="/v" images={IMAGES} index={0} onNavigate={onNavigate} onClose={noop} />,
    );
    await page.getByRole("button", { name: "second image" }).click();
    expect(onNavigate).toHaveBeenCalledWith(1);
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    await render(<ImageViewer dir="/v" images={IMAGES} index={0} onNavigate={noop} onClose={onClose} />);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("zoom controls update the percentage readout", async () => {
    await render(<ImageViewer dir="/v" images={IMAGES} index={0} onNavigate={noop} onClose={noop} />);
    await expect.element(page.getByText("100%")).toBeInTheDocument();
    await page.getByRole("button", { name: "Zoom in (+)" }).click();
    await expect.element(page.getByText("125%")).toBeInTheDocument();
    await page.getByRole("button", { name: "Zoom out (-)" }).click();
    await expect.element(page.getByText("100%")).toBeInTheDocument();
  });

  it("copies the image path via the clipboard API", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await render(<ImageViewer dir="/v" images={IMAGES} index={0} onNavigate={noop} onClose={noop} />);
    await page.getByRole("button", { name: "Copy image path" }).click();
    expect(writeText).toHaveBeenCalledWith(RED_DOT);
    writeText.mockRestore();
  });
});

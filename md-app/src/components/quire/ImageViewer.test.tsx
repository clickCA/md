import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import "@/index.css";
import { ImageViewer } from "./ImageViewer";

/* 1×1 red PNG — data URLs pass through resolveImage without touching Tauri */
const RED_DOT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const BLUE_DOT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYPhfDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const IMAGES = [
  { src: RED_DOT, alt: "first image" },
  { src: BLUE_DOT, alt: "second image" },
];

/* Three-image gallery for the swipe test: both swipe directions must land on
   distinct indices (with two images they wrap to the same one). */
const SWIPE_IMAGES = [
  { src: RED_DOT, alt: "first image" },
  { src: BLUE_DOT, alt: "second image" },
  {
    src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgMPhfDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    alt: "third image",
  },
];

const noop = () => {};

describe("ImageViewer", () => {
  it("renders the active image with its label", async () => {
    await render(
      <ImageViewer dir="/v" images={IMAGES} index={0} onNavigate={noop} onClose={noop} />,
    );
    const dialog = page.getByRole("dialog", { name: "Image viewer" });
    await expect.element(dialog).toBeInTheDocument();
    await expect.element(page.getByText("first image")).toBeInTheDocument();
    await expect.element(page.getByAltText("first image")).toBeInTheDocument();
  });

  it("hides gallery controls for a single image", async () => {
    await render(
      <ImageViewer dir="/v" images={[IMAGES[0]]} index={0} onNavigate={noop} onClose={noop} />,
    );
    await expect
      .element(page.getByRole("button", { name: "Previous image" }))
      .not.toBeInTheDocument();
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
    await render(
      <ImageViewer dir="/v" images={IMAGES} index={0} onNavigate={noop} onClose={onClose} />,
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("zoom controls update the percentage readout", async () => {
    await render(
      <ImageViewer dir="/v" images={IMAGES} index={0} onNavigate={noop} onClose={noop} />,
    );
    await expect.element(page.getByText("100%")).toBeInTheDocument();
    await page.getByRole("button", { name: "Zoom in (+)" }).click();
    await expect.element(page.getByText("125%")).toBeInTheDocument();
    await page.getByRole("button", { name: "Zoom out (-)" }).click();
    await expect.element(page.getByText("100%")).toBeInTheDocument();
  });

  it("copies the image path via the clipboard API", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await render(
      <ImageViewer dir="/v" images={IMAGES} index={0} onNavigate={noop} onClose={noop} />,
    );
    await page.getByRole("button", { name: "Copy image path" }).click();
    expect(writeText).toHaveBeenCalledWith(RED_DOT);
    writeText.mockRestore();
  });

  it("swipes between images", async () => {
    const onNavigate = vi.fn();
    await render(
      <ImageViewer
        dir="/v"
        images={SWIPE_IMAGES}
        index={0}
        onNavigate={onNavigate}
        onClose={noop}
      />,
    );
    const stage = document.querySelector('[data-testid="image-stage"]')!;
    const fire = (type: string, x: number) => {
      stage.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 7,
          pointerType: "touch",
          isPrimary: true,
          clientX: x,
          clientY: 200,
        }),
      );
    };
    fire("pointerdown", 300);
    fire("pointermove", 240);
    fire("pointermove", 150);
    fire("pointerup", 150);
    expect(onNavigate).toHaveBeenCalledWith(1); // swipe left → next image

    onNavigate.mockClear();
    fire("pointerdown", 150);
    fire("pointermove", 240);
    fire("pointermove", 300);
    fire("pointerup", 300);
    expect(onNavigate).toHaveBeenCalledWith(2); // swipe right → previous image (wraps to last)
  });

  it("does not swipe-navigate a single image or a dismissed gesture", async () => {
    const onNavigate = vi.fn();
    await render(
      <ImageViewer
        dir="/v"
        images={[IMAGES[0]]}
        index={0}
        onNavigate={onNavigate}
        onClose={noop}
      />,
    );
    const stage = document.querySelector('[data-testid="image-stage"]')!;
    const fire = (type: string, x: number) =>
      stage.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 7,
          pointerType: "touch",
          isPrimary: true,
          clientX: x,
          clientY: 200,
        }),
      );
    fire("pointerdown", 300);
    fire("pointermove", 200);
    fire("pointerup", 200);
    expect(onNavigate).not.toHaveBeenCalled(); // no gallery to navigate
  });
});

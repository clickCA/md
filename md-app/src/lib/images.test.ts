import { describe, expect, it } from "vitest";
import { extractImages, imageLabel, isExternalImage, isImageRef, mimeOf } from "./images";

describe("extractImages", () => {
  it("finds markdown images in order of appearance", () => {
    const md = [
      "intro",
      "",
      "![alpha](assets/a.png)",
      "text",
      "![beta](https://example.com/b.jpg)",
    ].join("\n");
    expect(extractImages(md)).toEqual([
      { src: "assets/a.png", alt: "alpha" },
      { src: "https://example.com/b.jpg", alt: "beta" },
    ]);
  });

  it("dedupes by source, keeping first occurrence", () => {
    const md = "![one](a.png)\n![two](a.png)\n![three](b.png)";
    const imgs = extractImages(md);
    expect(imgs.map((i) => i.src)).toEqual(["a.png", "b.png"]);
    expect(imgs[0].alt).toBe("one");
  });

  it("handles titles and angle-bracket sources", () => {
    expect(extractImages('![t](a.png "the title")')[0]?.src).toBe("a.png");
    expect(extractImages("![t](<my image.png>)")[0]?.src).toBe("my image.png");
  });

  it("ignores links and non-image markdown", () => {
    expect(extractImages("[link](a.png)")).toEqual([]);
    expect(extractImages("# heading\n\nsome **bold** text")).toEqual([]);
  });

  it("keeps wiki links and code fences out of the gallery", () => {
    const md = "[[Other note]]\n```\n![not an image](x.png)\n```";
    expect(extractImages(md)).toEqual([]);
  });

  it("returns empty for content without images", () => {
    expect(extractImages("")).toEqual([]);
  });
});

describe("imageLabel", () => {
  it("prefers alt text", () => {
    expect(imageLabel({ src: "assets/a.png", alt: "Screenshot" })).toBe("Screenshot");
  });

  it("falls back to the file name", () => {
    expect(imageLabel({ src: "assets/deep/name.jpeg", alt: "" })).toBe("name.jpeg");
    expect(imageLabel({ src: "assets/paste-123.png", alt: "  " })).toBe("paste-123.png");
  });
});

describe("mimeOf / isImageRef / isExternalImage", () => {
  it("maps extensions to mime types", () => {
    expect(mimeOf("a.png")).toBe("image/png");
    expect(mimeOf("a.JPG")).toBe("image/jpeg");
    expect(mimeOf("a.svg")).toBe("image/svg+xml");
    expect(mimeOf("a.webp")).toBe("image/webp");
    expect(mimeOf("a.txt")).toBe("application/octet-stream");
  });

  it("detects image references, ignoring query strings", () => {
    expect(isImageRef("assets/a.png")).toBe(true);
    expect(isImageRef("a.png?v=2")).toBe(true);
    expect(isImageRef("a.md")).toBe(false);
  });

  it("detects external references", () => {
    expect(isExternalImage("https://x/y.png")).toBe(true);
    expect(isExternalImage("data:image/png;base64,AA")).toBe(true);
    expect(isExternalImage("assets/a.png")).toBe(false);
  });
});

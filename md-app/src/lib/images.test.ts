import { describe, expect, it, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  blobToBase64,
  decodeImagePath,
  expandImageEmbeds,
  extractImages,
  imageExt,
  imageFiles,
  imageLabel,
  isExternalImage,
  isImageRef,
  isImageSource,
  mimeOf,
  resolveImage,
  wikiImageParts,
} from "./images";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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
    expect(isExternalImage("blob:x")).toBe(true);
    expect(isExternalImage("assets/a.png")).toBe(false);
  });
});

describe("decodeImagePath", () => {
  it("decodes percent-escaped paths", () => {
    expect(decodeImagePath("Images/Pasted%20image%201.png")).toBe("Images/Pasted image 1.png");
  });

  it("leaves plain paths untouched", () => {
    expect(decodeImagePath("assets/a.png")).toBe("assets/a.png");
  });

  it("falls back on invalid escapes (literal %)", () => {
    expect(decodeImagePath("50% off.png")).toBe("50% off.png");
  });
});

describe("imageLabel", () => {
  it("prefers alt text", () => {
    expect(imageLabel("assets/a.png", "Screenshot")).toBe("Screenshot");
  });

  it("falls back to the decoded file name", () => {
    expect(imageLabel("assets/paste-123.png", "")).toBe("paste-123.png");
    expect(imageLabel("Images/Pasted%20image%201.png", "  ")).toBe("Pasted image 1.png");
  });
});

describe("expandImageEmbeds / extractImages", () => {
  it("splits Obsidian embed bodies into source and alt text", () => {
    expect(wikiImageParts("Images/shot.png")).toEqual({ src: "Images/shot.png", alt: "" });
    expect(wikiImageParts("Images/shot.png|A shot")).toEqual({
      src: "Images/shot.png",
      alt: "A shot",
    });
    // Numeric alias is Obsidian's width hint, not alt text.
    expect(wikiImageParts("Images/shot.png|320")).toEqual({ src: "Images/shot.png", alt: "" });
  });

  it("expands image embeds into CommonMark images", () => {
    expect(expandImageEmbeds("![[Images/My shot.png]]")).toBe("![](<Images/My shot.png>)");
    // Non-image embeds stay untouched for the wikilink renderer.
    expect(expandImageEmbeds("![[Some Note]]")).toBe("![[Some Note]]");
  });

  it("extracts gallery images from both markdown and embeds, deduped", () => {
    const content = [
      "![first](Images/a.png)",
      "![[Images/b.png|Second]]",
      "![[Images/a.png]]",
      "![remote](https://example.com/c.jpg)",
      "```md",
      "![ignored](Images/code.png)",
      "```",
    ].join("\n");
    expect(extractImages(content)).toEqual([
      { src: "Images/a.png", alt: "first" },
      { src: "Images/b.png", alt: "Second" },
      { src: "https://example.com/c.jpg", alt: "remote" },
    ]);
  });

  it("treats vault paths and remote/data URLs as images", () => {
    expect(isImageSource("assets/a.png")).toBe(true);
    expect(isImageSource("https://example.com/a.png")).toBe(true);
    expect(isImageSource("data:image/png;base64,AA")).toBe(true);
    expect(isImageSource("notes/a.md")).toBe(false);
  });
});

describe("resolveImage", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("reads vault files through the backend as data URLs, decoding %20", async () => {
    vi.mocked(invoke).mockResolvedValue("QUJD");
    const url = await resolveImage("/vault", "Images/Pasted%20image%201.png");
    expect(invoke).toHaveBeenCalledWith("read_file_bytes", {
      dir: "/vault",
      path: "Images/Pasted image 1.png",
    });
    expect(url).toBe("data:image/png;base64,QUJD");
  });

  it("caches repeated references (backend hit once)", async () => {
    vi.mocked(invoke).mockResolvedValue("QUJD");
    await resolveImage("/vault", "a.png");
    await resolveImage("/vault", "a.png");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("passes external references through untouched", async () => {
    const url = await resolveImage("/vault", "https://example.com/a.png");
    expect(url).toBe("https://example.com/a.png");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("imageFiles / imageExt / blobToBase64", () => {
  it("collects only image files from a transfer payload", () => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "shot.png", { type: "image/png" }));
    dt.items.add(new File(["y"], "note.md", { type: "text/markdown" }));
    const files = imageFiles(dt);
    expect(files.map((f) => f.name)).toEqual(["shot.png"]);
  });

  it("returns empty for a null payload", () => {
    expect(imageFiles(null)).toEqual([]);
  });

  it("derives the stored extension from the name, else the mime type", () => {
    expect(imageExt(new File(["x"], "Pasted image.PNG", { type: "image/png" }))).toBe("png");
    expect(imageExt(new File(["x"], "image", { type: "image/webp" }))).toBe("webp");
    expect(imageExt(new File(["x"], "image", { type: "" }))).toBe("png");
  });

  it("reads a blob as the base64 payload", async () => {
    const b64 = await blobToBase64(new File(["abc"], "a.png", { type: "image/png" }));
    expect(b64).toBe(btoa("abc"));
  });
});

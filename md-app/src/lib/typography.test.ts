import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TYPOGRAPHY,
  TYPOGRAPHY_EVENT,
  TYPOGRAPHY_KEY,
  applyTypography,
  clampSize,
  isDefaultTypography,
  loadTypography,
  patchSurface,
  resetTypography,
  resolveFontFamily,
  saveTypography,
} from "./typography";

beforeEach(() => localStorage.removeItem(TYPOGRAPHY_KEY));

describe("typography settings", () => {
  it("defaults to a humanist editor, serif reading surface and mono code", () => {
    const settings = loadTypography();
    expect(settings).toEqual(DEFAULT_TYPOGRAPHY);
    expect(resolveFontFamily(settings, "editor")).toContain('"Avenir Next"');
    expect(resolveFontFamily(settings, "preview")).toContain("serif");
    expect(resolveFontFamily(settings, "code")).toContain("monospace");
  });

  it("persists settings and clamps sizes within their surface limits", () => {
    saveTypography({
      editor: { font: "humanist", custom: "", size: 22 },
      preview: { font: "serif", custom: "", size: 999 },
      code: { font: "mono", custom: "", size: 2 },
    });
    const loaded = loadTypography();
    expect(loaded.editor).toEqual({ font: "humanist", custom: "", size: 22 });
    expect(loaded.preview.size).toBe(30);
    expect(loaded.code.size).toBe(10);
  });

  it("heals invalid persisted values instead of throwing", () => {
    localStorage.setItem(
      TYPOGRAPHY_KEY,
      JSON.stringify({ editor: { font: "nope", size: "big" }, preview: 42 }),
    );
    const loaded = loadTypography();
    expect(loaded.editor).toEqual(DEFAULT_TYPOGRAPHY.editor);
    expect(loaded.preview).toEqual(DEFAULT_TYPOGRAPHY.preview);
  });

  it("ignores malformed JSON", () => {
    localStorage.setItem(TYPOGRAPHY_KEY, "{not json");
    expect(loadTypography()).toEqual(DEFAULT_TYPOGRAPHY);
  });

  it("applies each surface to the root as CSS custom properties", () => {
    const root = document.createElement("div");
    const settings = patchSurface(resetTypography(), "code", {
      font: "custom",
      custom: "Fira Sans",
      size: 18,
    });
    applyTypography(settings, root);
    expect(root.style.getPropertyValue("--editor-font-size")).toBe("16px");
    expect(root.style.getPropertyValue("--preview-font-size")).toBe("17px");
    expect(root.style.getPropertyValue("--code-font-size")).toBe("18px");
    const codeFamily = root.style.getPropertyValue("--code-font-family");
    expect(codeFamily.startsWith('"Fira Sans", ')).toBe(true);
    expect(codeFamily).toContain("monospace");
  });

  it("announces the change so editors can re-measure", () => {
    const heard = vi.fn();
    document.addEventListener(TYPOGRAPHY_EVENT, heard);
    try {
      applyTypography(resetTypography());
      expect(heard).toHaveBeenCalledOnce();
    } finally {
      document.removeEventListener(TYPOGRAPHY_EVENT, heard);
    }
  });

  it("quotes a bare custom family but passes a full stack through", () => {
    const bare = patchSurface(resetTypography(), "editor", {
      font: "custom",
      custom: "My Font",
    });
    expect(resolveFontFamily(bare, "editor").startsWith('"My Font", ')).toBe(true);

    const stack = patchSurface(resetTypography(), "editor", {
      font: "custom",
      custom: "My Font, system-ui, sans-serif",
    });
    expect(resolveFontFamily(stack, "editor")).toBe("My Font, system-ui, sans-serif");
  });

  it("falls back when a custom family is blank", () => {
    const blank = patchSurface(resetTypography(), "code", { font: "custom", custom: "  " });
    expect(resolveFontFamily(blank, "code")).toBe(resolveFontFamily(resetTypography(), "code"));
  });

  it("rounds and clamps sizes and detects a pristine state", () => {
    expect(clampSize("editor", 15.6)).toBe(16);
    expect(clampSize("editor", 100)).toBe(28);
    expect(isDefaultTypography(resetTypography())).toBe(true);
    expect(isDefaultTypography(patchSurface(resetTypography(), "preview", { size: 18 }))).toBe(
      false,
    );
  });
});

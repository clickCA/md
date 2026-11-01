/* Per-surface typography for the note editor, the rendered preview and code.
   The settings are persisted locally and applied as CSS custom properties on
   <html>, so CodeMirror, the preview and every code block update live without
   remounting any component. */

export const TYPOGRAPHY_KEY = "md.typography.v1";

/** Fired on the document after the root custom properties change, so
    CodeMirror can re-measure line heights and hitboxes. */
export const TYPOGRAPHY_EVENT = "md:typography-changed";

export type TypographySurface = "editor" | "preview" | "code";

export type FontId = "system" | "humanist" | "reading" | "serif" | "mono" | "custom";

export interface SurfaceTypography {
  font: FontId;
  /** CSS font-family entered by the user when `font` is "custom". */
  custom: string;
  size: number;
}

export interface TypographySettings {
  editor: SurfaceTypography;
  preview: SurfaceTypography;
  code: SurfaceTypography;
}

export interface FontOption {
  id: FontId;
  label: string;
  stack: string;
}

/* The stacks deliberately name cross-platform faces first and end with a
   generic family, so a missing font degrades to the platform's own choice
   instead of a hard-coded fallback. */
export const FONT_OPTIONS: FontOption[] = [
  {
    id: "system",
    label: "System sans",
    stack:
      '"Inter", "Segoe UI Variable Text", "Segoe UI", "Adwaita Sans", "Noto Sans", ui-sans-serif, system-ui, -apple-system, sans-serif',
  },
  {
    id: "humanist",
    label: "Humanist sans",
    stack:
      '"Avenir Next", "Segoe UI Variable Text", "Adwaita Sans", "Noto Sans", "Helvetica Neue", sans-serif',
  },
  {
    id: "reading",
    label: "Reading serif",
    stack:
      '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, Charter, "Sitka Text", Georgia, "Noto Serif", serif',
  },
  {
    id: "serif",
    label: "Classic serif",
    stack: 'Charter, "Bitstream Charter", Georgia, "Times New Roman", "Noto Serif", serif',
  },
  {
    id: "mono",
    label: "Monospace",
    stack:
      '"JetBrains Mono", "GeistMono Nerd Font Mono", "FiraCode Nerd Font Mono", "Cascadia Code", "SFMono-Regular", Menlo, Consolas, "Noto Sans Mono", monospace',
  },
  { id: "custom", label: "Custom…", stack: "" },
];

export const SURFACES: TypographySurface[] = ["editor", "preview", "code"];

export const SIZE_LIMITS: Record<TypographySurface, { min: number; max: number }> = {
  editor: { min: 12, max: 28 },
  preview: { min: 12, max: 30 },
  code: { min: 10, max: 24 },
};

/* Defaults are intentionally opinionated: prose reads in a serif, code in a
   real monospace, and the writing surface uses a humanist sans. They are all
   editable in Settings → Typography. */
export const DEFAULT_TYPOGRAPHY: TypographySettings = {
  editor: { font: "humanist", custom: "", size: 16 },
  preview: { font: "reading", custom: "", size: 17 },
  code: { font: "mono", custom: "", size: 14 },
};

const isFontId = (value: unknown): value is FontId =>
  FONT_OPTIONS.some((option) => option.id === value);

export const clampSize = (surface: TypographySurface, size: number) => {
  const { min, max } = SIZE_LIMITS[surface];
  return Math.min(max, Math.max(min, Math.round(size)));
};

const fallbackStack = (surface: TypographySurface) => {
  const id: FontId = surface === "code" ? "mono" : surface === "preview" ? "reading" : "system";
  return FONT_OPTIONS.find((option) => option.id === id)?.stack ?? FONT_OPTIONS[0].stack;
};

/** Resolve a surface's setting to a usable CSS font-family list. */
export function resolveFontFamily(
  settings: TypographySettings,
  surface: TypographySurface,
): string {
  const value = settings[surface];
  if (value.font !== "custom") {
    return FONT_OPTIONS.find((option) => option.id === value.font)?.stack ?? fallbackStack(surface);
  }
  const custom = value.custom.trim();
  if (!custom) return fallbackStack(surface);
  // A bare family name needs quoting; a full stack (contains a comma) is
  // passed through untouched so users can name a fallback list.
  return custom.includes(",") || custom.startsWith('"') || custom.startsWith("'")
    ? custom
    : `"${custom.replace(/["\\]/g, "")}", ${fallbackStack(surface)}`;
}

export function patchSurface(
  settings: TypographySettings,
  surface: TypographySurface,
  patch: Partial<SurfaceTypography>,
): TypographySettings {
  return { ...settings, [surface]: { ...settings[surface], ...patch } };
}

export function resetTypography(): TypographySettings {
  return {
    editor: { ...DEFAULT_TYPOGRAPHY.editor },
    preview: { ...DEFAULT_TYPOGRAPHY.preview },
    code: { ...DEFAULT_TYPOGRAPHY.code },
  };
}

/** Read persisted settings, healing missing/invalid fields from the defaults. */
export function loadTypography(): TypographySettings {
  const defaults = resetTypography();
  if (typeof localStorage === "undefined") return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(localStorage.getItem(TYPOGRAPHY_KEY) ?? "null");
  } catch {
    return defaults;
  }
  if (!parsed || typeof parsed !== "object") return defaults;

  for (const surface of SURFACES) {
    const raw = (parsed as Record<string, unknown>)[surface];
    if (!raw || typeof raw !== "object") continue;
    const value = raw as Record<string, unknown>;
    const fallback = defaults[surface];
    defaults[surface] = {
      font: isFontId(value.font) ? value.font : fallback.font,
      custom: typeof value.custom === "string" ? value.custom.slice(0, 160) : fallback.custom,
      size:
        typeof value.size === "number" && Number.isFinite(value.size)
          ? clampSize(surface, value.size)
          : fallback.size,
    };
  }
  return defaults;
}

export function saveTypography(settings: TypographySettings) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify(settings));
}

/** Apply settings to the document root as CSS custom properties. */
export function applyTypography(
  settings: TypographySettings,
  root: HTMLElement = document.documentElement,
) {
  for (const surface of SURFACES) {
    root.style.setProperty(`--${surface}-font-family`, resolveFontFamily(settings, surface));
    root.style.setProperty(
      `--${surface}-font-size`,
      `${clampSize(surface, settings[surface].size)}px`,
    );
  }
  const doc = root.ownerDocument;
  if (doc) doc.dispatchEvent(new Event(TYPOGRAPHY_EVENT));
}

export function isDefaultTypography(settings: TypographySettings) {
  return SURFACES.every(
    (surface) =>
      settings[surface].font === DEFAULT_TYPOGRAPHY[surface].font &&
      settings[surface].size === DEFAULT_TYPOGRAPHY[surface].size &&
      settings[surface].custom === DEFAULT_TYPOGRAPHY[surface].custom,
  );
}

import { Dialog } from "@base-ui/react/dialog";
import { Minus, Plus, RotateCcw, Type } from "lucide-react";
import {
  FONT_OPTIONS,
  SIZE_LIMITS,
  clampSize,
  isDefaultTypography,
  patchSurface,
  resetTypography,
  resolveFontFamily,
  type FontId,
  type TypographySettings,
  type TypographySurface,
} from "@/lib/typography";
import Modal from "../ui/Modal";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: TypographySettings;
  onChange: (settings: TypographySettings) => void;
}

const SECTIONS: Array<{
  id: TypographySurface;
  label: string;
  hint: string;
  sample: string;
}> = [
  {
    id: "editor",
    label: "Writing",
    hint: "The live markdown editor",
    sample: "The quick brown fox jumps over the lazy dog.",
  },
  {
    id: "preview",
    label: "Reading",
    hint: "Rendered notes in preview",
    sample: "A quiet, comfortable measure makes long notes easier to read.",
  },
  {
    id: "code",
    label: "Code",
    hint: "Fenced blocks and inline code, in both modes",
    sample: "const greet = (name: string) => `Hello, ${name}`;",
  },
];

export default function TypographySettingsDialog({
  open,
  onOpenChange,
  settings,
  onChange,
}: Props) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} className="top-[10vh] w-[30rem] max-w-[92vw]">
      <div className="mb-4 flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
          <Type className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <Dialog.Title className="text-sm font-semibold">Typography</Dialog.Title>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            Pick a font and size for each surface. Changes apply instantly and are saved on this
            machine.
          </p>
        </div>
      </div>

      <div className="flex max-h-[58vh] flex-col gap-3 overflow-y-auto pr-1">
        {SECTIONS.map(({ id, label, hint, sample }) => {
          const value = settings[id];
          const { min, max } = SIZE_LIMITS[id];
          const update = (patch: Partial<typeof value>) =>
            onChange(patchSurface(settings, id, patch));
          return (
            <section key={id} className="rounded-lg border border-border bg-card/60 p-3">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-[13px] font-medium text-foreground">{label}</h3>
                  <p className="text-[11px] text-muted-foreground">{hint}</p>
                </div>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {value.size}px
                </span>
              </div>

              <div className="flex items-center gap-2">
                <select
                  value={value.font}
                  onChange={(e) => update({ font: e.target.value as FontId })}
                  aria-label={`${label} font`}
                  className="h-8 min-w-0 flex-1 rounded-md border border-input bg-muted px-2 text-xs text-foreground outline-none focus:border-primary/60"
                >
                  {FONT_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>

                <div className="flex h-8 shrink-0 items-center rounded-md border border-input bg-muted">
                  <button
                    type="button"
                    aria-label={`Decrease ${label.toLowerCase()} font size`}
                    title="Smaller"
                    disabled={value.size <= min}
                    onClick={() => update({ size: clampSize(id, value.size - 1) })}
                    className="grid size-7 place-items-center text-muted-foreground hover:text-foreground disabled:opacity-35"
                  >
                    <Minus className="size-3" aria-hidden />
                  </button>
                  <input
                    type="number"
                    aria-label={`${label} font size`}
                    min={min}
                    max={max}
                    step={1}
                    value={value.size}
                    onChange={(e) => {
                      const next = e.currentTarget.valueAsNumber;
                      if (Number.isFinite(next)) update({ size: clampSize(id, next) });
                    }}
                    className="w-9 appearance-none bg-transparent text-center font-mono text-xs text-foreground outline-none"
                  />
                  <button
                    type="button"
                    aria-label={`Increase ${label.toLowerCase()} font size`}
                    title="Larger"
                    disabled={value.size >= max}
                    onClick={() => update({ size: clampSize(id, value.size + 1) })}
                    className="grid size-7 place-items-center text-muted-foreground hover:text-foreground disabled:opacity-35"
                  >
                    <Plus className="size-3" aria-hidden />
                  </button>
                </div>
              </div>

              {value.font === "custom" && (
                <input
                  value={value.custom}
                  onChange={(e) => update({ custom: e.target.value })}
                  aria-label={`${label} custom font family`}
                  placeholder='"Fira Sans", "Noto Sans", sans-serif'
                  spellCheck={false}
                  className="mt-2 h-8 w-full rounded-md border border-input bg-muted px-2 font-mono text-[11px] text-foreground outline-none focus:border-primary/60"
                />
              )}

              <p
                className="mt-2 overflow-hidden rounded-md border border-border/70 bg-background/50 px-3 py-2 text-muted-foreground"
                style={{
                  fontFamily: resolveFontFamily(settings, id),
                  fontSize: `${value.size}px`,
                  lineHeight: 1.55,
                }}
                aria-hidden
              >
                {sample}
              </p>
            </section>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => onChange(resetTypography())}
          disabled={isDefaultTypography(settings)}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-35"
        >
          <RotateCcw className="size-3" aria-hidden />
          Reset to defaults
        </button>
        <Dialog.Close className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground hover:opacity-90">
          Done
        </Dialog.Close>
      </div>
    </Modal>
  );
}

import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FolderOpen,
  ImageOff,
  Maximize,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { type ImageRef, imageLabel, resolveImage } from "@/lib/images";
import { cn } from "@/lib/utils";

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.25;
const WHEEL_STEP = 1.1;

type View = { scale: number; x: number; y: number; rot: 0 | 90 | 180 | 270 };
type Nat = { w: number; h: number };

const IDENTITY: View = { scale: 1, x: 0, y: 0, rot: 0 };

/** Scale that fits the (possibly rotated) image inside the stage; never upscales.
 *  Guards against unmeasured stages (width/height 0 → degenerate negative fits). */
function fitFor(cw: number, ch: number, nat: Nat, rot: number): number {
  if (cw < 64 || ch < 64 || !nat.w || !nat.h) return 1;
  const w = rot % 180 === 0 ? nat.w : nat.h;
  const h = rot % 180 === 0 ? nat.h : nat.w;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min((cw - 48) / w, (ch - 48) / h, 1)));
}

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

const hasTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Props = {
  dir: string;
  images: ImageRef[];
  index: number;
  onNavigate: (index: number) => void;
  onClose: () => void;
};

type Gesture = {
  mode: "none" | "pan" | "pinch";
  startX: number;
  startY: number;
  baseX: number;
  baseY: number;
  baseDist: number;
  baseScale: number;
  baseMidX: number;
  baseMidY: number;
  baseOffsetX: number;
  baseOffsetY: number;
  moved: boolean;
};

const idleGesture = (): Gesture => ({
  mode: "none",
  startX: 0,
  startY: 0,
  baseX: 0,
  baseY: 0,
  baseDist: 1,
  baseScale: 1,
  baseMidX: 0,
  baseMidY: 0,
  baseOffsetX: 0,
  baseOffsetY: 0,
  moved: false,
});

export function ImageViewer({ dir, images, index, onNavigate, onClose }: Props) {
  const count = images.length;
  const safeIndex = count === 0 ? 0 : Math.max(0, Math.min(index, count - 1));
  const current = count > 0 ? images[safeIndex] : null;

  const stageRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(IDENTITY);
  const viewRef = useRef(view);
  const [fit, setFit] = useState(1);
  const natRef = useRef<Nat | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revealing, setRevealing] = useState(false);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture>(idleGesture());
  const suppressClick = useRef(false);

  // keep the latest view readable inside non-reactive handlers (post-commit)
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  /* ── load the active image ─────────────────────────────────────────── */

  const src = current?.src ?? null;

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    natRef.current = null;
    setView(IDENTITY);
    setFit(1);
    if (!src) return;
    resolveImage(dir, src)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [dir, src]);

  /* ── zoom / fit / rotate ───────────────────────────────────────────── */

  const zoomTo = useCallback((next: number, cx = 0, cy = 0) => {
    const v = viewRef.current;
    const target = clampScale(next);
    const k = target / v.scale;
    setView({ ...v, scale: target, x: cx - k * (cx - v.x), y: cy - k * (cy - v.y) });
  }, []);

  const zoomBy = useCallback(
    (factor: number, cx = 0, cy = 0) => zoomTo(viewRef.current.scale * factor, cx, cy),
    [zoomTo],
  );

  const zoomFit = useCallback(() => {
    setView((v) => ({ scale: fit, x: 0, y: 0, rot: v.rot }));
  }, [fit]);

  const zoomActual = useCallback(() => {
    setView((v) => ({ ...v, scale: 1, x: 0, y: 0 }));
  }, []);

  const rotate = useCallback(() => {
    const stage = stageRef.current;
    const nat = natRef.current;
    const rot = ((viewRef.current.rot + 90) % 360) as View["rot"];
    let next = 1;
    if (stage && nat) {
      const r = stage.getBoundingClientRect();
      next = fitFor(r.width, r.height, nat, rot);
    }
    setFit(next);
    setView({ scale: next, x: 0, y: 0, rot });
  }, []);

  const recomputeFit = useCallback(
    (snap: boolean) => {
      const stage = stageRef.current;
      const nat = natRef.current;
      if (!stage || !nat) return;
      const r = stage.getBoundingClientRect();
      const oldFit = fit;
      const next = fitFor(r.width, r.height, nat, viewRef.current.rot);
      setFit(next);
      if (snap || Math.abs(viewRef.current.scale - oldFit) < 1e-3) {
        setView((v) => ({ scale: next, x: 0, y: 0, rot: v.rot }));
      }
    },
    [fit],
  );

  /* ── wheel zoom (non-passive so we can preventDefault) ─────────────── */

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const cx = e.clientX - r.left - r.width / 2;
      const cy = e.clientY - r.top - r.height / 2;
      zoomBy(e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, cx, cy);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  /* ── fit on load + keep fitted on stage resize ─────────────────────── */

  const onImgLoad = (e: ReactMouseEvent<HTMLImageElement> & { target: HTMLImageElement }) => {
    const img = e.currentTarget;
    const nat = { w: img.naturalWidth, h: img.naturalHeight };
    natRef.current = nat;
    const stage = stageRef.current;
    if (stage) {
      const r = stage.getBoundingClientRect();
      const fit = fitFor(r.width, r.height, nat, 0);
      setFit(fit);
      setView({ scale: fit, x: 0, y: 0, rot: 0 });
    }
  };

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => recomputeFit(false));
    ro.observe(stage);
    return () => ro.disconnect();
  }, [recomputeFit]);

  /* ── pan + pinch (pointer events) ──────────────────────────────────── */

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // never capture from interactive chrome — clicks must reach the buttons
    if ((e.target as HTMLElement).closest("button, a, input, textarea")) return;
    const stage = stageRef.current;
    if (!stage) return;
    suppressClick.current = false;
    stage.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (pointers.current.size === 1) {
      g.mode = "pan";
      g.startX = e.clientX;
      g.startY = e.clientY;
      g.baseX = viewRef.current.x;
      g.baseY = viewRef.current.y;
      g.moved = false;
      setDragging(true);
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      g.mode = "pinch";
      g.baseDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      g.baseScale = viewRef.current.scale;
      const r = stage.getBoundingClientRect();
      g.baseMidX = (a.x + b.x) / 2 - r.left - r.width / 2;
      g.baseMidY = (a.y + b.y) / 2 - r.top - r.height / 2;
      g.baseOffsetX = viewRef.current.x;
      g.baseOffsetY = viewRef.current.y;
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const stage = stageRef.current;
    if (!stage) return;
    if (g.mode === "pan" && pointers.current.size === 1) {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) g.moved = true;
      setView((v) => ({ ...v, x: g.baseX + dx, y: g.baseY + dy }));
    } else if (g.mode === "pinch" && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const r = stage.getBoundingClientRect();
      const mx = (a.x + b.x) / 2 - r.left - r.width / 2;
      const my = (a.y + b.y) / 2 - r.top - r.height / 2;
      const next = clampScale(g.baseScale * (dist / g.baseDist));
      const k = next / g.baseScale;
      setView((v) => ({
        ...v,
        scale: next,
        x: mx - k * (g.baseMidX - g.baseOffsetX),
        y: my - k * (g.baseMidY - g.baseOffsetY),
      }));
    }
  };

  const endPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      if (gesture.current.moved) suppressClick.current = true;
      gesture.current = idleGesture();
      setDragging(false);
    } else if (pointers.current.size === 1 && gesture.current.mode === "pinch") {
      const [p] = [...pointers.current.values()];
      const g = gesture.current;
      g.mode = "pan";
      g.startX = p.x;
      g.startY = p.y;
      g.baseX = viewRef.current.x;
      g.baseY = viewRef.current.y;
      g.moved = true;
    }
  };

  const onStageClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (e.target === e.currentTarget) onClose();
  };

  const onStageDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    if (Math.abs(viewRef.current.scale - 1) < 1e-3) {
      zoomFit();
    } else {
      const r = stage.getBoundingClientRect();
      zoomTo(1, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    }
  };

  /* ── gallery navigation + keyboard ─────────────────────────────────── */

  const go = useCallback(
    (delta: number) => {
      if (count < 2) return;
      onNavigate((safeIndex + delta + count) % count);
    },
    [count, safeIndex, onNavigate],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          go(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          go(1);
          break;
        case "+":
        case "=":
          e.preventDefault();
          zoomBy(ZOOM_STEP);
          break;
        case "-":
        case "_":
          e.preventDefault();
          zoomBy(1 / ZOOM_STEP);
          break;
        case "0":
          e.preventDefault();
          zoomFit();
          break;
        case "1":
          e.preventDefault();
          zoomActual();
          break;
        case "r":
        case "R":
          e.preventDefault();
          rotate();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose, zoomBy, zoomFit, zoomActual, rotate]);

  /* ── actions ───────────────────────────────────────────────────────── */

  const copyPath = async () => {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current.src);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — ignore
    }
  };

  const reveal = async () => {
    if (!current || !hasTauri()) return;
    setRevealing(true);
    try {
      const abs = await invoke<string>("vault_path", { dir, path: current.src });
      await revealItemInDir(abs);
    } catch {
      // command missing or unsupported platform — ignore
    }
    setRevealing(false);
  };

  if (!current) return null;

  /* ── chrome ────────────────────────────────────────────────────────── */

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      className="fixed inset-0 z-50 flex select-none flex-col bg-black/85 text-white backdrop-blur-[2px]"
    >
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 px-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="truncate text-sm text-white/90">{imageLabel(current)}</span>
          {count > 1 && (
            <span className="shrink-0 text-xs tabular-nums text-white/50">
              {safeIndex + 1} / {count}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ToolButton label={copied ? "Copied" : "Copy image path"} onClick={copyPath}>
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </ToolButton>
          {hasTauri() && (
            <ToolButton label="Reveal in file manager" onClick={reveal}>
              <FolderOpen className={cn("size-4", revealing && "animate-pulse")} />
            </ToolButton>
          )}
          <ToolButton label="Close (Esc)" onClick={onClose}>
            <X className="size-4" />
          </ToolButton>
        </div>
      </header>

      <div
        ref={stageRef}
        className={cn(
          "relative min-h-0 flex-1 touch-none overflow-hidden",
          dragging ? "cursor-grabbing" : "cursor-default",
        )}
        onClick={onStageClick}
        onDoubleClick={onStageDoubleClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
      >
        {url && (
          <img
            src={url}
            alt={current.alt}
            draggable={false}
            onLoad={onImgLoad}
            onError={() => setFailed(true)}
            className={cn(
              "absolute left-1/2 top-1/2 max-w-none rounded shadow-2xl",
              dragging ? "" : "transition-transform duration-150 ease-out",
            )}
            style={{
              transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) rotate(${view.rot}deg) scale(${view.scale})`,
              cursor: dragging ? "grabbing" : view.scale > fit + 1e-3 ? "grab" : "zoom-in",
            }}
          />
        )}
        {!url && !failed && (
          <span
            aria-label="Loading image"
            className="absolute left-1/2 top-1/2 size-8 -translate-x-1/2 -translate-y-1/2 animate-spin rounded-full border-2 border-white/20 border-t-white/80"
          />
        )}
        {failed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/60">
            <ImageOff className="size-8" aria-hidden />
            <span className="text-sm">Could not load {current.src}</span>
          </div>
        )}

        {count > 1 && (
          <>
            <NavButton side="left" onClick={() => go(-1)}>
              <ChevronLeft className="size-5" aria-hidden />
            </NavButton>
            <NavButton side="right" onClick={() => go(1)}>
              <ChevronRight className="size-5" aria-hidden />
            </NavButton>
          </>
        )}
      </div>

      <footer className="shrink-0 pb-3">
        <div className="flex items-center justify-center gap-1 py-2">
          <ToolButton label="Zoom out (-)" onClick={() => zoomBy(1 / ZOOM_STEP)}>
            <ZoomOut className="size-4" aria-hidden />
          </ToolButton>
          <span className="w-14 text-center text-xs tabular-nums text-white/70">
            {Math.round(view.scale * 100)}%
          </span>
          <ToolButton label="Zoom in (+)" onClick={() => zoomBy(ZOOM_STEP)}>
            <ZoomIn className="size-4" aria-hidden />
          </ToolButton>
          <ToolButton label="Fit to screen (0)" onClick={zoomFit}>
            <Maximize className="size-4" aria-hidden />
          </ToolButton>
          <ToolButton label="Actual size (1)" onClick={zoomActual}>
            <span className="text-[11px] font-medium leading-none">1:1</span>
          </ToolButton>
          <ToolButton label="Rotate 90° (R)" onClick={rotate}>
            <RotateCw className="size-4" aria-hidden />
          </ToolButton>
        </div>
        {count > 1 && (
          <div className="flex gap-1.5 overflow-x-auto px-4 py-1">
            {images.map((im, i) => (
              <Thumb
                key={im.src}
                dir={dir}
                image={im}
                active={i === safeIndex}
                onClick={() => onNavigate(i)}
              />
            ))}
          </div>
        )}
      </footer>
    </div>
  );
}

/* ── chrome bits ─────────────────────────────────────────────────────── */

function ToolButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-md text-white/75 transition hover:bg-white/15 hover:text-white"
    >
      {children}
    </button>
  );
}

function NavButton({
  side,
  onClick,
  children,
}: {
  side: "left" | "right";
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={side === "left" ? "Previous image" : "Next image"}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "absolute top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white/80 backdrop-blur transition hover:bg-white/25 hover:text-white",
        side === "left" ? "left-3" : "right-3",
      )}
    >
      {children}
    </button>
  );
}

function Thumb({
  dir,
  image,
  active,
  onClick,
}: {
  dir: string;
  image: ImageRef;
  active: boolean;
  onClick: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    resolveImage(dir, image.src)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dir, image.src]);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={imageLabel(image)}
      aria-current={active}
      className={cn(
        "h-14 w-20 shrink-0 overflow-hidden rounded border transition",
        active
          ? "border-primary ring-1 ring-primary"
          : "border-white/15 opacity-60 hover:opacity-100",
      )}
    >
      {url ? (
        <img src={url} alt="" draggable={false} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center bg-white/5 text-[10px] text-white/40">
          …
        </span>
      )}
    </button>
  );
}

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { springState, type Spring } from "@/lib/spring";

/* Native-feel drawer motion: pull-follow the finger, spring-settle on release.
   Positions are the panel's translateX in px: 0 = open, -width = closed.

   Gesture rules (Android-drawer-like):
   - Drag on the panel body left → follows the finger, rubber-bands past the
     closed/open edges, snaps by velocity then position on release.
   - A pull started within the left screen edge (drawer not yet mounted)
     reveals it live, one-to-one with the finger, then snaps the same way.
   - Vertical scroll inside the drawer stays native (`touch-action: pan-y`);
     horizontal gestures are ours, so the file tree still scrolls.

   Flow: the parent's `open` prop drives settle/spring animations through one
   effect; in-flight gestures own the panel directly and only hand back to the
   spring on release. `present` tracks whether the content is mounted so a
   closing drawer can animate out, then unmount. */

/* Native curves: open is a light spring with a ~2% overshoot (lively, material-
   like); close is near-critical so it lands fast without overshooting the
   closed edge. Both settle in ~300ms. */
const OPEN: Spring = { stiffness: 780, damping: 44 };
const CLOSE: Spring = { stiffness: 900, damping: 64 };

/** Pulls started within this many px of the left edge open the drawer. */
const EDGE_ZONE = 28;
/** Horizontal movement past this before a touch grabs the gesture. */
const ENGAGE_SLOP = 8;
/** Release velocity (px/s) that forces a direction regardless of position. */
const SNAP_VELOCITY = 320;
const MAX_VEL = 4000;

/** The drawer's rendered width — the panel owns it, so gestures can compute an
   off-screen offset even before the panel mounts (edge-drag takeover). */
const widthEstimate = () => Math.min(window.innerWidth * 0.85, 320);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/* Overscroll resistance past the settled edges: stiff, and capped so a
   determined pull reveals only a sliver beyond the open/closed ends (native
   drawers never show the whole sheet during rubber-band). `limit` is the
   asymptote in px; a 60px cap reads as ~45px reveal for an 180px pull. */
const MAX_OVERSHOOT = 60;
const rubberBand = (pull: number) => MAX_OVERSHOOT * (1 - 1 / (pull / MAX_OVERSHOOT + 1));

/** Fold a raw gesture offset into the panellable range with resistance past
   the settled edges. */
const resist = (raw: number, W: number) => {
  if (raw < -W) return -W - rubberBand(-(raw + W));
  if (raw > 0) return rubberBand(raw);
  return raw;
};

interface DragSession {
  engaged: boolean;
  startX: number;
  startY: number;
  startPos: number;
  pointerId: number;
  vx: number; // exponentially-decayed horizontal velocity (px/s)
  lastX: number;
  lastT: number;
}

export interface MobileDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

export function MobileDrawer({ open, onOpenChange, children }: MobileDrawerProps) {
  const [present, setPresent] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLButtonElement>(null);
  const widthRef = useRef(widthEstimate());
  const posRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const aimRef = useRef<number | null>(null);
  const dragRef = useRef<DragSession | null>(null);
  const releaseVelRef = useRef(0);
  const openRef = useRef(open);
  const presentRef = useRef(present);
  const reducedRef = useRef(false);

  // Mount as soon as the parent asks for open. Mounting happens here (render)
  // rather than in an effect so unmounting stays owned by the close spring
  // (finish) while opening never lags a render behind the prop change.
  if (open && !present) setPresent(true);

  const measure = useCallback(() => {
    const el = panelRef.current;
    if (el) widthRef.current = el.getBoundingClientRect().width || widthEstimate();
  }, []);

  const flush = useCallback((x: number) => {
    posRef.current = x;
    const panel = panelRef.current;
    if (panel) panel.style.transform = `translateX(${x.toFixed(2)}px)`;
    const scrim = scrimRef.current;
    if (scrim && widthRef.current > 0) {
      scrim.style.opacity = String(clamp(1 + x / widthRef.current, 0, 1));
    }
  }, []);

  const stop = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    aimRef.current = null;
  }, []);

  const finish = useCallback(
    (targetX: number) => {
      stop();
      flush(targetX);
      // A fully-closed drawer has no reason to stay mounted — unmount the
      // content so the idle tree/panels aren't rendered off-screen.
      if (targetX < 0 && !openRef.current) setPresent(false);
    },
    [flush, stop],
  );

  /** Spring from the panel's current position toward `targetX`. Idempotent per
     target so racing callers (prop effect + settle) never double-start. */
  const animateTo = useCallback(
    (targetX: number, vel: number) => {
      if (rafRef.current !== null && aimRef.current === targetX) return;
      if (!presentRef.current || !panelRef.current) {
        flush(targetX);
        return;
      }
      stop();
      aimRef.current = targetX;
      const x0 = posRef.current;
      const v0 = clamp(vel, -MAX_VEL, MAX_VEL);
      const params = targetX < 0 ? CLOSE : OPEN;
      const t0 = performance.now();

      if (reducedRef.current) {
        finish(targetX);
        return;
      }

      const loop = (now: number) => {
        // The first rAF timestamp can land a hair before `t0`; clamp to 0 so
        // the closed-form spring never extrapolates backwards into garbage.
        const t = Math.max(0, Math.min((now - t0) / 1000, 2));
        const { x, v } = springState(x0, v0, targetX, params, t);
        flush(x);
        if (Math.abs(x - targetX) < 0.5 && Math.abs(v) < 30) {
          finish(targetX);
          return;
        }
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    },
    [finish, flush, stop],
  );

  const track = useCallback((s: DragSession, x: number, stamp: number) => {
    if (stamp > s.lastT) {
      const inst = (x - s.lastX) / ((stamp - s.lastT) / 1000);
      s.vx = s.vx * 0.6 + inst * 0.4;
    }
    s.lastX = x;
    s.lastT = stamp;
  }, []);

  /** Decide the settled side after release, then hand the panel back to the
     spring — via the prop flip when one happened, directly otherwise. */
  const settle = useCallback(
    (vx: number) => {
      if (!presentRef.current) return;
      const W = widthRef.current;
      const goingOpen = vx > SNAP_VELOCITY;
      const goingClosed = vx < -SNAP_VELOCITY;
      const targetX = goingOpen ? 0 : goingClosed ? -W : posRef.current < -W / 2 ? -W : 0;

      if (targetX < 0) {
        releaseVelRef.current = vx;
        if (openRef.current) {
          onOpenChange(false); // prop flip → [open] effect springs it out
        } else {
          animateTo(-W, vx); // prop unchanged (mid-close regrab) — animate directly
          releaseVelRef.current = 0;
        }
      } else {
        releaseVelRef.current = vx;
        if (!openRef.current) {
          onOpenChange(true); // prop flip → [open] effect springs it open
        } else {
          animateTo(0, vx); // prop unchanged (stay open) — animate directly
          releaseVelRef.current = 0;
        }
      }
    },
    [animateTo, onOpenChange],
  );

  /* Mount lifecycle: `present` flips once per show, so this effect runs once
     each time the panel appears. It plants the panel at the closed edge (no
     flash), then either holds still (edge-drag takeover) or springs open. */
  useEffect(() => {
    presentRef.current = present;
    if (!present) return;
    measure();
    flush(-widthRef.current);
    if (dragRef.current?.engaged) return; // edge-drag owns the panel
    if (openRef.current) {
      animateTo(0, releaseVelRef.current);
      releaseVelRef.current = 0;
    }
  }, [present, animateTo, flush, measure]);

  /* Parent-driven open/close (header button, backdrop tap, back gesture,
     editors closing it). A gesture in flight owns the motion — skip. Mounting
     happens during render (see above); here we only animate the mounted panel. */
  useEffect(() => {
    openRef.current = open;
    if (dragRef.current?.engaged) return;
    if (!presentRef.current) return;
    if (open) animateTo(0, releaseVelRef.current);
    else animateTo(-widthRef.current, releaseVelRef.current);
    releaseVelRef.current = 0;
  }, [open, animateTo]);

  const onPanelPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.("button, a, input, textarea")) return;
    stop(); // a grab interrupts the settle animation mid-flight
    dragRef.current = {
      engaged: false,
      startX: e.clientX,
      startY: e.clientY,
      startPos: posRef.current,
      pointerId: e.pointerId,
      vx: 0,
      lastX: e.clientX,
      lastT: e.timeStamp, // DOMHighResTimeStamp — ms, same base as performance.now
    };
  };

  const onPanelPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = dragRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    if (!s.engaged) {
      const dx = e.clientX - s.startX;
      const dy = e.clientY - s.startY;
      if (Math.abs(dx) < ENGAGE_SLOP) return;
      if (Math.abs(dy) > Math.abs(dx) * 1.2) {
        dragRef.current = null; // vertical scroll — stay native
        return;
      }
      s.engaged = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* proceed without capture */
      }
    }
    track(s, e.clientX, e.timeStamp);
    flush(resist(s.startPos + (e.clientX - s.startX), widthRef.current));
  };

  const onPanelPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = dragRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (!s.engaged) return; // a tap or scroll
    settle(s.vx);
  };

  const onPanelPointerCancel = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    // The browser took the gesture (scroll): snap back to the settled side.
    if (openRef.current && presentRef.current) animateTo(0, 0);
  };

  /* Closed-drawer edge pull: one-to-one follow from the left screen edge.
     Touches on interactive elements, outside the edge zone, or on wide screens
     are never taken over, and vertical scroll from the edge stays native until
     a clearly horizontal pull proves intent. */
  useEffect(() => {
    let start: { x: number; y: number; t: number } | null = null;

    const onStart = (e: TouchEvent) => {
      if (presentRef.current || openRef.current) return; // panel is mounted — it owns gestures
      if (window.matchMedia("(min-width: 768px)").matches) return; // desktop
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (t.clientX > EDGE_ZONE) return;
      const el = t.target as HTMLElement | null;
      if (el?.closest?.("button, a, input, textarea, [data-tauri-drag-region]")) return;
      start = { x: t.clientX, y: t.clientY, t: performance.now() };
      window.addEventListener("touchmove", onMove, { passive: false });
    };

    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const s = start;
      const t = e.touches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (!dragRef.current?.engaged) {
        if (Math.abs(dx) < ENGAGE_SLOP) return;
        if (Math.abs(dy) > Math.abs(dx) * 1.2) return; // vertical scroll — leave it
        setPresent(true); // mount at the closed edge
        onOpenChange(true); // keep back-gesture/editor bookkeeping honest
        dragRef.current = {
          engaged: true,
          startX: s.x,
          startY: s.y,
          startPos: -widthRef.current,
          pointerId: -1,
          vx: 0,
          lastX: s.x,
          lastT: s.t,
        };
      }
      e.preventDefault(); // stop the page scroll that would fight the pull
      track(dragRef.current, t.clientX, performance.now());
      flush(resist(-widthRef.current + (t.clientX - s.x), widthRef.current));
    };

    const onEnd = (e: TouchEvent) => {
      if (!start) return;
      start = null;
      window.removeEventListener("touchmove", onMove);
      const drag = dragRef.current;
      if (!drag?.engaged) return;
      const t = e.changedTouches[0];
      track(drag, t.clientX, performance.now());
      dragRef.current = null;
      settle(drag.vx);
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
    };
  }, [settle, track, onOpenChange, flush]);

  useEffect(() => {
    reducedRef.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  // The whole overlay (scrim + panel) mounts only while the drawer is active —
  // a hidden full-screen scrim would eat every tap on the app. Unmounting is
  // owned by the close spring's `finish`, so nothing intercepts when closed.
  if (!present) return null;

  return (
    <div className="fixed inset-0 z-40 md:hidden">
      <button
        ref={scrimRef}
        type="button"
        aria-label="Close sidebar"
        className="absolute inset-0 bg-background/80"
        style={{ opacity: 0, willChange: "opacity" }}
        onClick={() => onOpenChange(false)}
      />
      <div
        ref={panelRef}
        onPointerDown={onPanelPointerDown}
        onPointerMove={onPanelPointerMove}
        onPointerUp={onPanelPointerUp}
        onPointerCancel={onPanelPointerCancel}
        style={{
          position: "absolute",
          inset: "0 auto 0 0",
          width: "min(85vw, 20rem)",
          touchAction: "pan-y",
          willChange: "transform",
          transform: "translateX(-100%)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

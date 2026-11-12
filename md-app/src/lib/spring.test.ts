import { describe, expect, it } from "vitest";
import { springState, type Spring } from "./spring";

/* These constants mirror the drawer springs (MobileDrawer.tsx) — keep them in
   sync. The tests check the qualitative behaviour that makes a drawer feel
   native: a ~2% overshoot on open (lively), a no-overshoot fast close, a
   velocity burst absorbed back into the target, and a settle under ~400ms so
   the motion never drags. */

const OPEN: Spring = { stiffness: 780, damping: 44 };
const CLOSE: Spring = { stiffness: 900, damping: 64 };

/** Simulate an animation loop: walk the analytic spring forward and report
   the first time it is within the settle window (0.5px, 30px/s). */
function settleTime(x0: number, v0: number, target: number, p: Spring) {
  for (let t = 0; t <= 4; t += 0.004) {
    const { x, v } = springState(x0, v0, target, p, t);
    if (Math.abs(x - target) < 0.5 && Math.abs(v) < 30) return t;
  }
  return Infinity;
}

describe("springState", () => {
  it("starts at the given position and velocity", () => {
    const s = springState(40, -200, 100, OPEN, 0);
    expect(s.x).toBe(40);
    expect(s.v).toBe(-200);
  });

  it("open motion reaches the target with a hint of overshoot", () => {
    let maxAbove = -Infinity;
    for (let t = 0.001; t <= 4; t += 0.001) {
      maxAbove = Math.max(maxAbove, springState(0, 0, 100, OPEN, t).x);
    }
    expect(maxAbove).toBeGreaterThan(101); // subtle overshoot = lively, native
    expect(maxAbove).toBeLessThan(104); // ...but not a bounce
    const settled = springState(0, 0, 100, OPEN, 2);
    expect(Math.abs(settled.x - 100)).toBeLessThan(0.5);
    expect(Math.abs(settled.v)).toBeLessThan(1);
  });

  it("close motion is fast and never overshoots the closed edge, even under a fling", () => {
    let min = 0;
    for (let t = 0.001; t <= 2; t += 0.001) {
      min = Math.min(min, springState(0, -1400, -320, CLOSE, t).x);
      expect(min).toBeGreaterThanOrEqual(-320 - 1e-6);
    }
  });

  it("open/close both settle quickly enough to feel native", () => {
    expect(settleTime(0, 0, 300, OPEN)).toBeLessThan(0.45); // a whole drawer width
    expect(settleTime(0, 0, -300, CLOSE)).toBeLessThan(0.45);
  });

  it("a velocity burst pushes the panel, then decays back to the target", () => {
    const s = springState(0, 2200, 0, OPEN, 2);
    expect(Math.abs(s.x)).toBeLessThan(2); // back at rest near the target
    expect(Math.abs(s.v)).toBeLessThan(30);
  });
});

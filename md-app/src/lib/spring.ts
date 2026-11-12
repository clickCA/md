/* Damped-spring motion for drawers/sheets, integrated in closed form (mass 1).
   Frame-rate independent: evaluate x(t) straight from the analytic solution, so
   opening, closing and gesture release all land on the same curve no matter how
   the animation frames are spaced. */

export interface Spring {
  /** ωₙ², the undamped natural frequency squared (mass = 1). */
  stiffness: number;
  /** The damping coefficient c (mass = 1): 2·ζ·ωₙ. */
  damping: number;
}

export interface SpringState {
  x: number;
  v: number;
}

/**
 * Position and velocity of a damped oscillator at time `t` (seconds), starting
 * at (x0, v0) and asymptotically approaching `target`. Handles the under-,
 * over- and critically damped regimes.
 */
export function springState(
  x0: number,
  v0: number,
  target: number,
  p: Spring,
  t: number,
): SpringState {
  const wn = Math.sqrt(p.stiffness);
  const zeta = p.damping / (2 * wn);
  const dx = x0 - target;

  if (zeta >= 1) {
    const d = wn * Math.sqrt(zeta * zeta - 1);
    if (d < 1e-6) {
      // Critically damped: (A + B·t)·e⁻ωₙᵗ.
      const e = Math.exp(-wn * t);
      const b = v0 + wn * dx;
      return { x: target + (dx + b * t) * e, v: (b - wn * (dx + b * t)) * e };
    }
    // Overdamped: two distinct real roots.
    const r1 = -zeta * wn + d;
    const r2 = -zeta * wn - d;
    const a2 = (v0 - r1 * dx) / (r2 - r1);
    const a1 = dx - a2;
    const e1 = Math.exp(r1 * t);
    const e2 = Math.exp(r2 * t);
    return { x: target + a1 * e1 + a2 * e2, v: r1 * a1 * e1 + r2 * a2 * e2 };
  }

  // Underdamped: e⁻ζωₙᵗ·(A·cos + B·sin).
  const wd = wn * Math.sqrt(1 - zeta * zeta);
  const a = dx;
  const b = (v0 + zeta * wn * dx) / wd;
  const e = Math.exp(-zeta * wn * t);
  const cos = Math.cos(wd * t);
  const sin = Math.sin(wd * t);
  return {
    x: target + e * (a * cos + b * sin),
    v: -zeta * wn * e * (a * cos + b * sin) + e * (-a * wd * sin + b * wd * cos),
  };
}

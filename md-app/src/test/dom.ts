/**
 * DOM and timing primitives shared by browser suites. They exist so the
 * settle dance and the synthetic input shapes are defined once, not
 * reinvented per suite.
 */

/**
 * Let the DOM settle: CodeMirror measures line heights on animation
 * frames, and React commits land between frames. Wait two, then assert.
 */
export function settle(): Promise<void> {
  return new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

/**
 * Real delay — for suites that must pace input (spring velocity reads
 * release speed) or wait out an animation. Not for settling the DOM; use
 * settle().
 */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A primary-mouse PointerEvent: button 0 on press, release carries no
 * buttons so drag handlers read a lifted finger. Touch variants (different
 * pointerId/type semantics) stay local to the suite that needs them.
 */
export function pointerEvent(type: string, x: number, y = 50): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: type === "pointerdown" ? 0 : -1,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: x,
    clientY: y,
  });
}

import { useEffect, useRef } from "react";

type BackState = { mdBackClose?: string };

let seq = 0;

/**
 * Wire an overlay's open state to the system back gesture / back button
 * (Android). Tauri's WryActivity routes back presses to webview history, and
 * the React app holds no router history of its own — so while an overlay is
 * open we push exactly one history entry for it. A back press pops that entry
 * and closes the overlay instead of leaving the app; over overlays stack
 * naturally because each open overlay owns its own entry.
 *
 * Closing from the UI (button, backdrop tap, Escape) consumes the entry
 * programmatically, keeping the stack level with the visible overlays.
 */
export function useBackClose(open: boolean, close: () => void) {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });

  useEffect(() => {
    if (!open) return;
    const token = `md-${Date.now().toString(36)}-${++seq}`;
    history.pushState({ mdBackClose: token }, "");
    const onPop = (e: PopStateEvent) => {
      // Popped to the entry below ours (base state or another overlay's
      // token) — the system back gesture asked for this overlay to close.
      if ((e.state as BackState | null)?.mdBackClose !== token) closeRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      const state = (history.state as BackState | null)?.mdBackClose;
      if (state !== token) return; // popped by back already — nothing to consume
      // Closed from the UI. Defer one tick so same-commit pushes from sibling
      // overlays land first, then consume our entry only while it is on top.
      queueMicrotask(() => {
        if ((history.state as BackState | null)?.mdBackClose === token) history.back();
      });
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}

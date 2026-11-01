import { useEffect, useRef, useState } from "react";

/* Below this width a sidebar + editor split is too cramped — the sidebar
   would squeeze the editor against its floor. Auto-collapse there, and
   restore when there's room again. */
const MIN_WINDOW = 900;

/**
 * Sidebar visibility with narrow-window auto-collapse.
 *
 * `open` is what's on screen right now. `setOpen`/`toggle` record the user's
 * intent — the last explicit choice is what comes back when the window grows
 * past the threshold again. Crossing the threshold down always collapses.
 */
export function useSidebarAutoCollapse() {
  // Start collapsed on narrow windows — no open-then-collapse flash.
  const [open, setOpenState] = useState(
    () => window.matchMedia(`(min-width: ${MIN_WINDOW}px)`).matches,
  );
  const intent = useRef(true);

  const setOpen = (value: boolean) => {
    intent.current = value;
    setOpenState(value);
  };

  const toggle = () =>
    setOpenState((prev) => {
      intent.current = !prev;
      return !prev;
    });

  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${MIN_WINDOW}px)`);
    const apply = () => setOpenState(mq.matches ? intent.current : false);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  return { open, setOpen, toggle };
}

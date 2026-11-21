import { useState } from "react";
import { page } from "vitest/browser";
import { MobileDrawer } from "@/components/quire/MobileDrawer";

/**
 * Shared mount + geometry helpers for the MobileDrawer suites. One suite
 * runs bare (no stylesheet), the other loads index.css — import that in
 * the suite, not here, so the bare one stays bare.
 */
export function DrawerHarness({ initialOpen = false }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)}>
        toggle
      </button>
      <MobileDrawer open={open} onOpenChange={setOpen}>
        <div data-testid="content">drawer body</div>
      </MobileDrawer>
    </div>
  );
}

/** The translating (panel) wrapper — the parent of the harness content. */
export const panelEl = (): HTMLElement | null =>
  page.getByTestId("content").query()?.parentElement ?? null;

/** Current translateX of the panel, NaN when no transform is set. */
export const transformX = (): number => {
  const el = panelEl();
  const m = el ? /translateX\(([-\d.]+)px\)/.exec(el.style.transform) : null;
  return m ? Number(m[1]) : NaN;
};

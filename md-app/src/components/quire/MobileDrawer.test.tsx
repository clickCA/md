import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { MobileDrawer } from "./MobileDrawer";

/* The drawer's paint-behaviour (transform, scrim opacity, mount/unmount) is
   plain inline styles, so it works in the browser-test harness with no
   stylesheet. The translating element is the parent of the test content div;
   its x-offset follows the finger 1:1 during a drag, then springs to a side.

   Notes on the harness: without Tailwind's `md:hidden` the fixed overlay is
   always "visible", so the harness toggle and backdrop must be clicked via
   `element().click()` (bypasses hit-testing, which isn't the point here).
   Velocity snaps by release speed, so drags are paced with real delays and end
   in a "hold" (same-x moves), just like a finger that stops before lifting —
   letting the release POSITION decide the settle. */

const panelEl = (): HTMLElement | null => {
  const el = page.getByTestId("content").query();
  return el?.parentElement ?? null; // the translating (panel) wrapper
};
const transformX = (): number => {
  const el = panelEl();
  const m = el ? /translateX\(([-.\d]+)px\)/.exec(el.style.transform) : null;
  return m ? Number(m[1]) : NaN;
};
const scrim = () => page.getByRole("button", { name: "Close sidebar" });
const scrimOpacity = () => scrim().element().style.opacity;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait out the spring and assert the panel settled on `expected`. */
const settledX = async (expected: number) => {
  await sleep(600);
  expect(transformX()).toBeCloseTo(expected, 1);
};

const pointer = (type: string, x: number, y = 50) =>
  new PointerEvent(type, {
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

/** Drag on the mounted panel: pointerdown at `from`, paced moves through
   `path`, a held stop (kill release velocity), then pointerup. */
async function panelDrag(body: Element, from: number, path: number[]) {
  body.dispatchEvent(pointer("pointerdown", from));
  await sleep(8);
  for (const x of path) {
    body.dispatchEvent(pointer("pointermove", x));
    await sleep(16);
  }
  const end = path[path.length - 1];
  for (let i = 0; i < 6; i++) {
    body.dispatchEvent(pointer("pointermove", end));
    await sleep(5);
  }
  await sleep(8);
  body.dispatchEvent(pointer("pointerup", end));
}

const makeTouch = (x: number, y: number, target: Node) =>
  new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y });

const touchEvent = (type: "touchstart" | "touchmove" | "touchend", t: Touch) =>
  new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: type === "touchend" ? [] : [t],
    targetTouches: type === "touchend" ? [] : [t],
    changedTouches: [t],
  });

/** Paced moves for an edge pull (no release yet — assert the follow first). */
async function edgeMoves(path: number[]) {
  const t0 = makeTouch(path[0], 400, document.body);
  document.body.dispatchEvent(touchEvent("touchstart", t0));
  await sleep(8);
  for (const x of path.slice(1)) {
    document.body.dispatchEvent(touchEvent("touchmove", makeTouch(x, 400, document.body)));
    await sleep(16);
  }
}

/** Release an edge pull at `x` after a held stop. */
async function edgeRelease(x: number) {
  for (let i = 0; i < 6; i++) {
    document.body.dispatchEvent(touchEvent("touchmove", makeTouch(x, 400, document.body)));
    await sleep(5);
  }
  await sleep(8);
  document.body.dispatchEvent(touchEvent("touchend", makeTouch(x, 400, document.body)));
}

function Harness({ initialOpen = false }: { initialOpen?: boolean }) {
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

describe("MobileDrawer", () => {
  beforeEach(async () => {
    await page.viewport(390, 844); // phone-ish; drawer width = 320
  });

  it("starts hidden and animates open when the prop flips", async () => {
    await render(<Harness />);
    expect(page.getByTestId("content").query()).toBeNull();

    await (page.getByRole("button", { name: "toggle" }).element() as HTMLElement).click();
    await sleep(40);
    expect(page.getByTestId("content").query()).not.toBeNull();
    expect(transformX()).toBeLessThan(0); // mid-slide, not instant

    await settledX(0);
    expect(scrimOpacity()).toBe("1");
  });

  it("closes with animation and unmounts the content", async () => {
    await render(<Harness initialOpen />);
    await settledX(0);

    await (page.getByRole("button", { name: "toggle" }).element() as HTMLElement).click();
    await sleep(40);
    expect(page.getByTestId("content").query()).not.toBeNull(); // still animating out
    expect(transformX()).toBeLessThan(0);

    await sleep(700);
    expect(page.getByTestId("content").query()).toBeNull(); // unmounted once hidden
  });

  it("tapping the backdrop closes the drawer", async () => {
    await render(<Harness initialOpen />);
    await settledX(0);

    (scrim().element() as HTMLElement).click();
    await sleep(700);
    expect(page.getByTestId("content").query()).toBeNull();
  });

  it("follows a drag-to-close 1:1 and snaps closed past the midpoint", async () => {
    await render(<Harness initialOpen />);
    await settledX(0);

    const body = page.getByTestId("content").element();
    await panelDrag(body, 220, [180, 120, 80, 40]); // ends at 40 → -180
    expect(transformX()).toBeCloseTo(-180, 0); // 1:1 with the finger

    await sleep(700);
    expect(page.getByTestId("content").query()).toBeNull(); // past -160 → closed
  });

  it("snaps back to open after a short pull that never crosses the midpoint", async () => {
    await render(<Harness initialOpen />);
    await settledX(0);

    const body = page.getByTestId("content").element();
    await panelDrag(body, 200, [170, 140, 130]); // ends at 130 → -70 (above -160)
    await settledX(0); // springs back open
    expect(scrimOpacity()).toBe("1");
  });

  it("ignores vertical drags inside the drawer", async () => {
    await render(<Harness initialOpen />);
    await settledX(0);

    const body = page.getByTestId("content").element();
    body.dispatchEvent(pointer("pointerdown", 200, 50));
    body.dispatchEvent(pointer("pointermove", 205, 120));
    await sleep(16);
    body.dispatchEvent(pointer("pointerup", 205, 120));

    await settledX(0); // never moved — stayed open
  });

  it("rubber-bands when pulled past the open edge, then springs back", async () => {
    await render(<Harness initialOpen />);
    await settledX(0);

    const body = page.getByTestId("content").element();
    body.dispatchEvent(pointer("pointerdown", 180));
    body.dispatchEvent(pointer("pointermove", 360));
    await sleep(16);
    body.dispatchEvent(pointer("pointerup", 360));

    // Pulled +180px but the overscroll turns into only a stiff reveal.
    const resisted = transformX();
    expect(resisted).toBeGreaterThan(0);
    expect(resisted).toBeLessThan(100);
    await settledX(0);
  });

  it("opens from a left-edge pull, following the finger, snapping open", async () => {
    await render(<Harness />);
    expect(page.getByTestId("content").query()).toBeNull();

    await edgeMoves([10, 120, 200, 240]);
    await sleep(40); // engage + panel mount
    expect(page.getByTestId("content").query()).not.toBeNull();
    expect(transformX()).toBeCloseTo(-90, 0); // -320 + (240 - 10) → 1:1 follow

    await edgeRelease(240);
    await settledX(0);
    expect(scrimOpacity()).toBe("1");
  });

  it("snaps closed when the edge pull stops short of the midpoint", async () => {
    await render(<Harness />);

    await edgeMoves([8, 60, 110, 140]); // -320 + 132 = -188, past the midpoint
    await edgeRelease(140);

    await sleep(700);
    expect(page.getByTestId("content").query()).toBeNull(); // snapped closed
  });
});

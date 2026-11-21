import { beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { sleep } from "@/test/dom";
import { DrawerHarness, panelEl } from "@/test/drawerHarness";
// Real app styles (Tailwind + theme primitives). The other drawer tests run
// without a stylesheet, so styled geometry (width, layout, tap-to-open) is
// unverified there. Note: the bare vitest page cannot run Tailwind's
// content-scan, so class-generated utilities like `fixed` / `md:hidden` do not
// exist here — they are verified present in the built dist CSS instead.
import "../../index.css";

const content = () => page.getByTestId("content");

describe("MobileDrawer (styled)", () => {
  beforeEach(async () => {
    await page.viewport(390, 844); // phone
  });

  it("opens into a correctly-sized panel on a phone viewport", async () => {
    await render(<DrawerHarness initialOpen />);
    await sleep(650);

    const el = panelEl();
    expect(el).not.toBeNull();
    // Sized by the drawer's width rule: min(85vw, 20rem) ≈ 320px at 390 wide.
    const w = el!.getBoundingClientRect().width;
    expect(w).toBeGreaterThan(280);
    expect(w).toBeLessThanOrEqual(320);
    // Settled open: transform resolved to the identity position.
    const x = /translateX\(([-\d.]+)px\)/.exec(el!.style.transform);
    expect(x ? Math.abs(Number(x[1])) : 0).toBeLessThan(1);
  });

  it("tap-to-open works with real styles at phone width", async () => {
    await render(<DrawerHarness />);
    expect(content().query()).toBeNull();

    await (page.getByRole("button", { name: "toggle" }).element() as HTMLElement).click();
    await sleep(650);
    expect(content().query()).not.toBeNull();
    const el = panelEl()!;
    const x = /translateX\(([-\d.]+)px\)/.exec(el.style.transform);
    expect(x ? Math.abs(Number(x[1])) : 0).toBeLessThan(1);
  });
});

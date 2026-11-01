import { beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { Sidebar } from "./sidebar";

const noop = () => {};

async function renderSidebar(resizable?: boolean) {
  await render(
    /* Same shape as the workspace: a full-height flex row so the aside (and
       its drag handle) stretches to a real height. */
    <div className="flex h-96 w-full">
      <Sidebar
        panel="files"
        vaultName="Notes"
        isRepo
        hasRemote={false}
        onOpenFolder={noop}
        changeCount={0}
        sync="idle"
        lastSynced="never"
        dark={false}
        onToggleTheme={noop}
        onPanel={noop}
        onCollapse={noop}
        onDailyNote={noop}
        onNewNote={noop}
        onSync={noop}
        resizable={resizable}
      >
        <div>panel body</div>
      </Sidebar>
    </div>,
  );
}

const handle = () => page.getByRole("separator", { name: "Resize sidebar" });
const aside = () => page.getByRole("complementary", { name: "Vault" });

/* Tests run inside the browser, so read geometry straight off the DOM and
   let React flush one frame before asserting. */
const widthAfterFlush = async () => {
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  return aside().element().getBoundingClientRect().width;
};

const pointer = (type: string, x: number) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: type === "pointerdown" ? 0 : -1,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: x,
    clientY: 50,
  });

describe("Sidebar resize", () => {
  beforeEach(async () => {
    localStorage.removeItem("md.sidebar-width");
    // Pin the viewport: the resize clamp is window-aware, tests assume 1280px
    // (max width 480, default 256).
    await page.viewport(1280, 800);
  });

  it("renders with the default width and exposes the resize handle", async () => {
    await renderSidebar();
    await expect.element(handle()).toBeInTheDocument();
    expect(await widthAfterFlush()).toBe(256);
  });

  it("resizes by dragging the edge and persists the width", async () => {
    await renderSidebar();
    const el = handle().element();
    el.dispatchEvent(pointer("pointerdown", 200));
    el.dispatchEvent(pointer("pointermove", 300)); // +100 → 356
    el.dispatchEvent(pointer("pointermove", 340)); // +140 → 396 (not 356+140)
    el.dispatchEvent(pointer("pointerup", 340));
    expect(await widthAfterFlush()).toBe(396);
    expect(localStorage.getItem("md.sidebar-width")).toBe("396");
  });

  it("clamps drags to the allowed range", async () => {
    await renderSidebar();
    const el = handle().element();
    el.dispatchEvent(pointer("pointerdown", 200));
    el.dispatchEvent(pointer("pointermove", 2000));
    el.dispatchEvent(pointer("pointerup", 2000));
    expect(await widthAfterFlush()).toBe(480);
    expect(localStorage.getItem("md.sidebar-width")).toBe("480");
  });

  it("clamps a persisted out-of-range width", async () => {
    localStorage.setItem("md.sidebar-width", "9999");
    await renderSidebar();
    expect(await widthAfterFlush()).toBe(480);
  });

  it("ignores garbage persisted values", async () => {
    localStorage.setItem("md.sidebar-width", "not-a-number");
    await renderSidebar();
    expect(await widthAfterFlush()).toBe(256);
  });

  it("resizes with the keyboard and resets on double-click", async () => {
    await renderSidebar();
    const el = handle().element();
    el.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(await widthAfterFlush()).toBe(272);
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(await widthAfterFlush()).toBe(320);
    // Synthetic dblclick: the test page loads no stylesheet, so the handle
    // has no Tailwind-driven box for a real mouse dblclick to target.
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
    expect(await widthAfterFlush()).toBe(256);
    expect(localStorage.getItem("md.sidebar-width")).toBe("256");
  });

  it("has no resize handle when resizable is false", async () => {
    await renderSidebar(false);
    await expect.element(handle()).not.toBeInTheDocument();
  });
});

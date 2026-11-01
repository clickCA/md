import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { useSidebarAutoCollapse } from "./useSidebarAutoCollapse";

const WIDE = 1280;
const NARROW = 800;

function Probe() {
  const { open, setOpen, toggle } = useSidebarAutoCollapse();
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        close
      </button>
      <button type="button" onClick={toggle}>
        toggle
      </button>
      <p data-testid="state">{open ? "open" : "closed"}</p>
    </div>
  );
}

const state = () => page.getByTestId("state");

describe("useSidebarAutoCollapse", () => {
  it("starts open on a wide window and collapsed on a narrow one", async () => {
    await page.viewport(WIDE, 600);
    await render(<Probe />);
    await expect.element(state()).toHaveTextContent("open");

    await page.viewport(NARROW, 600);
    await expect.element(state()).toHaveTextContent("closed");
  });

  it("restores the sidebar when the window grows again", async () => {
    await page.viewport(WIDE, 600);
    await render(<Probe />);
    await expect.element(state()).toHaveTextContent("open");

    await page.viewport(NARROW, 600);
    await expect.element(state()).toHaveTextContent("closed");

    await page.viewport(WIDE, 600);
    await expect.element(state()).toHaveTextContent("open");
  });

  it("lets the user open it manually while narrow", async () => {
    await page.viewport(NARROW, 600);
    await render(<Probe />);
    await expect.element(state()).toHaveTextContent("closed");

    await page.getByRole("button", { name: "open" }).click();
    await expect.element(state()).toHaveTextContent("open");
  });

  it("keeps an explicit close sticky across resize", async () => {
    await page.viewport(WIDE, 600);
    await render(<Probe />);
    await page.getByRole("button", { name: "close" }).click();
    await expect.element(state()).toHaveTextContent("closed");

    await page.viewport(NARROW, 600);
    await expect.element(state()).toHaveTextContent("closed");

    await page.viewport(WIDE, 600);
    // The user closed it on purpose — growing the window must not reopen it.
    await expect.element(state()).toHaveTextContent("closed");
  });

  it("toggle records intent too", async () => {
    await page.viewport(WIDE, 600);
    await render(<Probe />);
    await page.getByRole("button", { name: "toggle" }).click(); // open → closed
    await expect.element(state()).toHaveTextContent("closed");

    await page.viewport(NARROW, 600);
    await page.getByRole("button", { name: "toggle" }).click(); // manual open
    await expect.element(state()).toHaveTextContent("open");

    await page.viewport(WIDE, 600);
    await expect.element(state()).toHaveTextContent("open");
  });
});

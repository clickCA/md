import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { useBackClose } from "./useBackClose";

type BackState = { mdBackClose?: string };

function Probe({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
    onClose();
  };
  useBackClose(open, close);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        close
      </button>
      <p data-testid="state">{open ? "open" : "closed"}</p>
    </div>
  );
}

const state = () => page.getByTestId("state");
const topToken = () => (history.state as BackState | null)?.mdBackClose;

describe("useBackClose", () => {
  it("system back closes the overlay instead of leaving the app", async () => {
    const onClose = vi.fn();
    await render(<Probe onClose={onClose} />);
    await page.getByRole("button", { name: "open" }).click();
    await expect.element(state()).toHaveTextContent("open");
    expect(topToken()).toBeDefined(); // overlay holds one history entry

    history.back(); // simulates the system back gesture
    await expect.element(state()).toHaveTextContent("closed");
    expect(onClose).toHaveBeenCalled();
  });

  it("closing from the UI consumes the history entry", async () => {
    await render(<Probe onClose={vi.fn()} />);
    await page.getByRole("button", { name: "open" }).click();
    await expect.element(state()).toHaveTextContent("open");
    expect(topToken()).toBeDefined();

    await page.getByRole("button", { name: "close" }).click();
    await expect.element(state()).toHaveTextContent("closed");
    await expect.poll(topToken).toBeUndefined(); // entry popped, stack level
  });
});

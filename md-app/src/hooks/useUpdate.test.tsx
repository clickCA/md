import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { useUpdate } from "./useUpdate";

/** Renders the hook's public state so the effect can be observed. */
function Probe() {
  const updater = useUpdate();
  return (
    <div>
      {updater.update ? `update:${updater.update.version}` : "no-update"}
      {updater.error ? ` error:${updater.error}` : ""}
    </div>
  );
}

describe("useUpdate", () => {
  it("stays idle outside a Tauri runtime (dev browser / vitest)", async () => {
    await render(<Probe />);

    // The startup effect may fire but must not blow up or claim an update
    // exists when there is no Tauri host to check against.
    await expect.element(page.getByText("no-update")).toBeVisible();
    expect(page.getByText(/update:/).elements()).toHaveLength(0);
  });
});

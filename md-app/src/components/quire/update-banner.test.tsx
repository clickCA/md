import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import type { Update } from "@tauri-apps/plugin-updater";
import { UpdateBanner } from "./update-banner";

/** The banner only reads fields off the update — a structural stand-in is
    enough to drive it without a live updater plugin. */
const fakeUpdate = { version: "0.2.0" } as unknown as Update;

async function renderBanner(overrides: Partial<Parameters<typeof UpdateBanner>[0]> = {}) {
  const onInstall = vi.fn();
  const onDismiss = vi.fn();
  await render(
    <UpdateBanner
      update={null}
      installing={false}
      error={null}
      onInstall={onInstall}
      onDismiss={onDismiss}
      {...overrides}
    />,
  );
  return { onInstall, onDismiss };
}

describe("UpdateBanner", () => {
  it("renders nothing while no update is available", async () => {
    await renderBanner();
    expect(page.getByText("Update available").elements()).toHaveLength(0);
  });

  it("shows the new version with install and dismiss actions", async () => {
    await renderBanner({ update: fakeUpdate });

    await expect.element(page.getByText("Update available")).toBeVisible();
    await expect.element(page.getByText(/0\.2\.0/)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Restart & update" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Not now" })).toBeVisible();
  });

  it("fires install and dismiss handlers", async () => {
    const { onInstall, onDismiss } = await renderBanner({ update: fakeUpdate });

    await page.getByRole("button", { name: "Restart & update" }).click();
    await page.getByRole("button", { name: "Not now" }).click();

    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("swaps to an installing state and surfaces errors", async () => {
    await renderBanner({
      update: fakeUpdate,
      installing: true,
      error: "download failed",
    });

    await expect.element(page.getByText("Installing…")).toBeVisible();
    await expect.element(page.getByText("download failed")).toBeVisible();
  });
});

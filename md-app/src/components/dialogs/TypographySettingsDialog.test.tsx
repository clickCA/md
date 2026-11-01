import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { patchSurface, resetTypography, type TypographySettings } from "@/lib/typography";
import TypographySettingsDialog from "./TypographySettingsDialog";

const noop = () => {};

async function renderDialog(settings = resetTypography(), onChange = vi.fn()) {
  await render(
    <TypographySettingsDialog open onOpenChange={noop} settings={settings} onChange={onChange} />,
  );
  return { onChange };
}

describe("TypographySettingsDialog", () => {
  it("offers a font and size control for every surface", async () => {
    await renderDialog();
    for (const label of ["Writing", "Reading", "Code"]) {
      await expect
        .element(page.getByRole("combobox", { name: `${label} font` }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("spinbutton", { name: `${label} font size` }))
        .toBeInTheDocument();
    }
  });

  it("updates the reading font without touching the other surfaces", async () => {
    const { onChange } = await renderDialog();
    const select = page.getByRole("combobox", { name: "Reading font" }).element();
    (select as HTMLSelectElement).value = "serif";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        editor: expect.objectContaining({ font: "humanist" }),
        preview: expect.objectContaining({ font: "serif" }),
        code: expect.objectContaining({ font: "mono" }),
      }),
    );
  });

  it("steps the code size and clamps it", async () => {
    const { onChange } = await renderDialog();
    // Base UI's focus guard covers the popup in the test page, so dispatch the
    // click directly (the same approach the sidebar drag tests use).
    page
      .getByRole("button", { name: "Increase code font size" })
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: expect.objectContaining({ size: 15 }) }),
    );
  });

  it("reveals a custom font field and can reset to defaults", async () => {
    const custom: TypographySettings = patchSurface(resetTypography(), "editor", {
      font: "custom",
      custom: "My Font",
    });
    const { onChange } = await renderDialog(custom);
    await expect
      .element(page.getByRole("textbox", { name: "Writing custom font family" }))
      .toHaveValue("My Font");
    page
      .getByRole("button", { name: "Reset to defaults" })
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onChange).toHaveBeenCalledWith(resetTypography());
  });
});

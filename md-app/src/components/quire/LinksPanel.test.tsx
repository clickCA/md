import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import type { BrokenLink } from "@/types";
import { LinksPanel } from "./LinksPanel";

const rows: BrokenLink[] = [
  {
    source: "notes/a.md",
    target: "ghost",
    line: 2,
    kind: "wiki",
    text: "ghost",
  },
  {
    source: "b.md",
    target: "nope/missing.md",
    line: 1,
    kind: "markdown",
    text: "missing",
  },
];

async function renderPanel(report: BrokenLink[] | null, loading = false) {
  const onRescan = vi.fn();
  const onOpenLink = vi.fn();
  await render(
    <LinksPanel report={report} loading={loading} onRescan={onRescan} onOpenLink={onOpenLink} />,
  );
  return { onRescan, onOpenLink };
}

describe("LinksPanel", () => {
  it("explains the scan before the first run", async () => {
    await renderPanel(null);

    await expect.element(page.getByText(/Scan the vault for unresolved/)).toBeVisible();
  });

  it("lists every broken link with its source location", async () => {
    await renderPanel(rows);

    await expect.element(page.getByText("ghost")).toBeVisible();
    await expect.element(page.getByText("nope/missing.md")).toBeVisible();
    const rows2 = page.getByTitle(/Open .* at line/).elements();
    expect(rows2).toHaveLength(2);
    await expect.element(page.getByTitle(/Open notes\/a\.md at line 2/)).toBeVisible();
  });

  it("opens the source note at the reference on click", async () => {
    const { onOpenLink } = await renderPanel(rows);

    await page.getByTitle(/Open notes\/a\.md at line 2/).click();
    expect(onOpenLink).toHaveBeenCalledWith("notes/a.md", 2);
  });

  it("celebrates a clean report and rescans on demand", async () => {
    const { onRescan } = await renderPanel([], false);

    await expect.element(page.getByText("All links resolve — no broken references.")).toBeVisible();
    await page.getByRole("button", { name: "Rescan links" }).click();
    expect(onRescan).toHaveBeenCalled();
  });
});

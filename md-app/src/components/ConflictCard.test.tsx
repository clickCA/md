import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { invoke } from "@tauri-apps/api/core";
import ConflictCard from "./ConflictCard";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const conflict = {
  path: "notes/clash.md",
  conflictCopy: "notes/clash.conflict-1730000000.md",
  winner: "ours",
};

const WINNER = "# Clash\n\nkept line\n";
const COPY = "# Clash\n\ncopy line\n";

/** note_read answers from here; every other command resolves void. */
function mockReads(winner: string, copy: string) {
  vi.mocked(invoke).mockImplementation(async (cmd: unknown, args?: unknown) => {
    const { path } = (args ?? {}) as { path?: string };
    if (cmd === "note_read") return path === conflict.path ? winner : copy;
    return undefined;
  });
}

async function renderCard(onResolved = vi.fn()) {
  await render(
    <ConflictCard dir="/vault" conflicts={[conflict]} busy={false} onResolved={onResolved} />,
  );
  return { onResolved };
}

describe("ConflictCard", () => {
  it("renders nothing without conflicts", async () => {
    const { container } = await render(
      <ConflictCard dir="/vault" conflicts={[]} busy={false} onResolved={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("deletes the copy when keeping the winner", async () => {
    const { onResolved } = await renderCard();

    await userEvent.click(page.getByText("keep winner"));

    expect(invoke).toHaveBeenCalledWith("note_delete", {
      dir: "/vault",
      path: conflict.conflictCopy,
    });
    expect(onResolved).toHaveBeenCalledOnce();
  });

  it("restores the copy over the winner, then removes the copy", async () => {
    mockReads(WINNER, COPY);
    const { onResolved } = await renderCard();

    await userEvent.click(page.getByText("restore copy"));

    expect(invoke).toHaveBeenCalledWith("note_read", {
      dir: "/vault",
      path: conflict.conflictCopy,
    });
    expect(invoke).toHaveBeenCalledWith("note_write", {
      dir: "/vault",
      path: conflict.path,
      content: COPY,
    });
    expect(invoke).toHaveBeenCalledWith("note_delete", {
      dir: "/vault",
      path: conflict.conflictCopy,
    });
    expect(onResolved).toHaveBeenCalledOnce();
  });

  it("previews the winner-vs-copy diff and closes it again", async () => {
    mockReads(WINNER, COPY);
    await renderCard();

    await userEvent.click(page.getByText("view diff"));

    await expect.element(page.getByText(/kept winner/)).toBeVisible();
    await expect.element(page.getByText(/conflict copy/)).toBeVisible();
    await expect.element(page.getByText(/copy line/)).toBeVisible();
    await expect.element(page.getByText(/-kept line|-kept/)).toBeVisible();

    await userEvent.click(page.getByText("hide diff"));
    await expect.element(page.getByText("view diff")).toBeVisible();
  });
});

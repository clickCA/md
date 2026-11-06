import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import type { VaultFile } from "@/lib/vault";
import { MarkdownEditor } from "./note-editor";
import "../../index.css";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), revealItemInDir: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class FakeChannel {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));

const noop = () => {};

const PROVIDERS = [
  { id: "opencode", label: "opencode", available: true, installHint: "install opencode" },
];

/** Deferred ai_text result so tests can edit the document mid-generation. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

type AiTextResult = { status: string; text: string; durationMs: number };

/** Install the invoke mock; returns the deferred ai_text handle. */
function mockCore(providers = PROVIDERS) {
  const aiDeferred = deferred<AiTextResult>();
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    if (cmd === "agent_detect") return Promise.resolve(providers);
    if (cmd === "ai_text") return aiDeferred.promise;
    return Promise.reject(new Error(`unexpected command in test: ${cmd}`));
  });
  return aiDeferred;
}

const DOC = "Alpha paragraph.\n\nBeta paragraph.\n";

async function setup(content = DOC, onChange: (content: string) => void = noop) {
  const file: VaultFile = { path: "notes/Note.md", content, committed: null };
  await render(
    <MarkdownEditor file={file} dir="/vault" onChange={onChange} onCursor={noop} dark={false} />,
  );
  const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
  return view;
}

/** Select the first paragraph ("Alpha paragraph.\n" = 17 chars) and start AI. */
async function startRewrite(view: EditorView) {
  view.dispatch({ selection: { anchor: 0, head: 17 } });
  await page.getByRole("button", { name: "AI rewrite" }).click();
  await expect.element(page.getByText("AI is rewriting…")).toBeVisible();
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("selection AI in the editor", () => {
  it("accept applies the suggestion to exactly the captured selection", async () => {
    const changes: string[] = [];
    const view = await setup(DOC, (c: string) => {
      changes.push(c);
    });
    const aiDeferred = mockCore();
    await startRewrite(view);
    aiDeferred.resolve({ status: "done", text: "Alpha, rewritten.\n", durationMs: 5 });
    await expect.element(page.getByText("AI suggestion")).toBeVisible();
    await page.getByRole("button", { name: "Accept" }).click();

    expect(view.state.doc.toString()).toBe("Alpha, rewritten.\n\nBeta paragraph.\n");
    expect(changes.at(-1)).toBe("Alpha, rewritten.\n\nBeta paragraph.\n");
  });

  it("reject leaves the document byte-identical", async () => {
    const changes: string[] = [];
    const view = await setup(DOC, (c: string) => {
      changes.push(c);
    });
    const aiDeferred = mockCore();
    await startRewrite(view);
    aiDeferred.resolve({ status: "done", text: "Totally different.", durationMs: 5 });
    await expect.element(page.getByText("AI suggestion")).toBeVisible();
    await page.getByRole("button", { name: "Discard" }).click();

    expect(view.state.doc.toString()).toBe(DOC);
    expect(changes).toEqual([]);
  });

  it("THE CRITICAL TEST: an edit while generating makes the result stale — paragraph B survives", async () => {
    const changes: string[] = [];
    const view = await setup(DOC, (c: string) => {
      changes.push(c);
    });
    const aiDeferred = mockCore();
    await startRewrite(view);

    // The user edits paragraph B while the AI is running.
    const beta = view.state.doc.line(3);
    view.dispatch({ changes: { from: beta.from, to: beta.to, insert: "Beta paragraph EDITED." } });
    const docWithB = view.state.doc.toString();

    aiDeferred.resolve({ status: "done", text: "Alpha, rewritten.\n", durationMs: 5 });
    await expect.element(page.getByText("AI suggestion")).toBeVisible();

    // Stale state: the warning is shown, Accept is disabled.
    await expect
      .element(
        page.getByText(
          "The note changed while the AI was running — apply is refused. Discard or regenerate against the current text.",
        ),
      )
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Accept" })).toBeDisabled();

    // The user discards: paragraph B's edit survives, no AI text anywhere.
    await page.getByRole("button", { name: "Discard" }).click();
    expect(view.state.doc.toString()).toBe(docWithB);
    expect(view.state.doc.toString()).toContain("Beta paragraph EDITED.");
    expect(view.state.doc.toString()).not.toContain("Alpha, rewritten.");
    // onChange fired only for the user's own edit.
    expect(changes).toEqual([docWithB]);
  });

  it("a collapsed selection does not invalidate the request — accept applies to the intended range", async () => {
    const view = await setup(DOC);
    const aiDeferred = mockCore();
    await startRewrite(view);

    // The user clicks elsewhere: the live selection collapses/moves.
    view.dispatch({ selection: { anchor: 0 } });

    aiDeferred.resolve({ status: "done", text: "Alpha, rewritten.\n", durationMs: 5 });
    await expect.element(page.getByText("AI suggestion")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Accept" })).toBeEnabled();
    await page.getByRole("button", { name: "Accept" }).click();

    expect(view.state.doc.toString()).toBe("Alpha, rewritten.\n\nBeta paragraph.\n");
  });

  it("an empty timeout reply shows the hint and the editor stays usable", async () => {
    const view = await setup(DOC);
    const aiDeferred = mockCore();
    await startRewrite(view);
    aiDeferred.resolve({ status: "timeout", text: "", durationMs: 120_000 });

    await expect.element(page.getByText("the AI timed out — try again")).toBeVisible();
    await page.getByRole("button", { name: "Dismiss" }).click();

    // Editor fully usable afterwards: typing works.
    view.dispatch({ changes: { from: 0, to: 0, insert: "typed " } });
    expect(view.state.doc.toString().startsWith("typed Alpha")).toBe(true);
  });

  it("with no provider installed the card shows the install hint", async () => {
    const view = await setup(DOC);
    mockCore([
      { id: "opencode", label: "opencode", available: false, installHint: "npm i -g opencode-ai" },
    ]);
    // agent_detect resolves instantly, so the generating phase may flash
    // past — assert only on the end state.
    view.dispatch({ selection: { anchor: 0, head: 17 } });
    await page.getByRole("button", { name: "AI rewrite" }).click();
    await expect.element(page.getByText("npm i -g opencode-ai")).toBeVisible();
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it("regenerate re-runs with a fresh capture after an edit", async () => {
    const view = await setup(DOC);
    const aiDeferred = mockCore();
    await startRewrite(view);

    // Edit B while generating → stale.
    const beta = view.state.doc.line(3);
    view.dispatch({ changes: { from: beta.from, to: beta.to, insert: "Beta EDITED." } });
    aiDeferred.resolve({ status: "done", text: "Stale suggestion.", durationMs: 5 });
    await expect.element(page.getByText("AI suggestion")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Accept" })).toBeDisabled();

    // Regenerate issues a NEW ai_text request against the current document.
    const second = deferred<AiTextResult>();
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "agent_detect") return Promise.resolve(PROVIDERS);
      if (cmd === "ai_text") return second.promise;
      return Promise.reject(new Error(`unexpected command in test: ${cmd}`));
    });
    await page.getByRole("button", { name: "Regenerate" }).click();
    await expect.element(page.getByText("AI is rewriting…")).toBeVisible();
    second.resolve({ status: "done", text: "Fresh suggestion.", durationMs: 5 });
    await expect.element(page.getByText("AI suggestion")).toBeVisible();
    await page.getByRole("button", { name: "Accept" }).click();

    expect(view.state.doc.toString()).toBe("Fresh suggestion.\n\nBeta EDITED.\n");
  });
});

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { invoke } from "@tauri-apps/api/core";
import { AskPanel } from "./ask-panel";
import "../../index.css";

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

const SYNC_CONTENT = "intro\nthe sync engine commits notes\ntail\n";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const search = vi.fn();

function mockCore(opts: {
  providers?: typeof PROVIDERS;
  content?: string;
  ai?: ReturnType<typeof deferred<AiTextResult>>;
}) {
  const ai = opts.ai ?? deferred<AiTextResult>();
  vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
    const a = (args ?? {}) as { path?: string };
    if (cmd === "agent_detect") return Promise.resolve(opts.providers ?? PROVIDERS);
    if (cmd === "note_read") {
      if (a.path === "notes/sync.md") return Promise.resolve(opts.content ?? SYNC_CONTENT);
      return Promise.reject(new Error("missing file"));
    }
    if (cmd === "ai_text") return ai.promise;
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  }) as typeof invoke);
  return ai;
}

type AiTextResult = { status: string; text: string; durationMs: number };

async function ask(question: string) {
  await page.getByLabelText("Question").fill(question);
  await page.getByRole("button", { name: "Ask" }).click();
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  // Default: one matching note. mockResolvedValue in a test persists, so
  // every test starts from a known implementation.
  search.mockImplementation(async () => [
    { path: "notes/sync.md", matches: [{ line: 2, snippet: "sync engine" }] },
  ]);
});

describe("AskPanel", () => {
  it("answers with citations from real notes; clicking a source opens the note", async () => {
    const onOpen = vi.fn();
    const ai = mockCore({});
    await render(<AskPanel dir="/vault" search={search} onOpen={onOpen} />);
    await ask("How does sync work?");

    ai.resolve({ status: "done", text: "The engine commits notes [1].", durationMs: 5 });
    await expect.element(page.getByText("The engine commits notes [1].")).toBeVisible();

    // Sources: the note we fed the model, with its line number. (The
    // button's name has no spaces — JSX strips inter-element whitespace.)
    await expect.element(page.getByText("Sources")).toBeVisible();
    await page.getByRole("button", { name: /sync/ }).click();
    expect(onOpen).toHaveBeenCalledWith("notes/sync.md");
  });

  it("sends the instruction + numbered context to the model", async () => {
    mockCore({});
    await render(<AskPanel dir="/vault" search={search} onOpen={noop} />);
    await ask("How does sync work?");
    // The ai_text promise is still pending — the call already happened.
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "ai_text")?.[1] as {
      instruction: string;
      options: { context?: string };
    };
    expect(call.instruction).toContain("NOT ENOUGH INFORMATION");
    expect(call.options.context).toContain("Question: How does sync work?");
    expect(call.options.context).toContain("[1] notes/sync.md:2");
    expect(call.options.context).toContain("the sync engine commits notes");
  });

  it("with no matching notes it answers honestly and never calls the model", async () => {
    const onOpen = vi.fn();
    search.mockResolvedValue([]);
    mockCore({});
    await render(<AskPanel dir="/vault" search={search} onOpen={onOpen} />);
    await ask("what is the secret?");
    await expect.element(page.getByText("No notes match", { exact: false })).toBeVisible();
    const aiCalls = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "ai_text");
    expect(aiCalls.length).toBe(0);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("an unreadable note is skipped; all-failed retrieval stays honest", async () => {
    search.mockResolvedValue([{ path: "notes/gone.md", matches: [{ line: 1, snippet: "x" }] }]);
    mockCore({});
    await render(<AskPanel dir="/vault" search={search} onOpen={noop} />);
    await ask("anything");
    await expect.element(page.getByText("No notes match", { exact: false })).toBeVisible();
  });

  it("no provider installed shows the install hint", async () => {
    mockCore({
      providers: [
        {
          id: "opencode",
          label: "opencode",
          available: false,
          installHint: "npm i -g opencode-ai",
        },
      ],
    });
    await render(<AskPanel dir="/vault" search={search} onOpen={noop} />);
    await ask("How does sync work?");
    await expect.element(page.getByText("npm i -g opencode-ai")).toBeVisible();
  });
});

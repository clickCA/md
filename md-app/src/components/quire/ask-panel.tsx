import { useState } from "react";
import { Sparkles, TriangleAlert, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "@/lib/ipc";
import { pickAiProvider, runAiText, stopAi } from "@/lib/ai";
import { readAgentProvider, type AgentProviderInfo } from "@/lib/agent";
import { ASK_INSTRUCTION, buildContext, retrieveSources, type AskSource } from "@/lib/ask";
import { fileName } from "@/lib/vault";
import type { SearchHit } from "@/hooks/useVault";
import { PanelHeader } from "./panel-header";

type Props = {
  dir: string;
  /** The app's filtered FTS search (excluded paths never appear). */
  search: (query: string) => Promise<SearchHit[]>;
  onOpen: (path: string) => void;
};

type Phase =
  | { kind: "idle" }
  | { kind: "thinking" }
  | { kind: "answer"; question: string; answer: string; sources: AskSource[] }
  | { kind: "empty"; question: string }
  | { kind: "hint"; hint: string };

const btn =
  "flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Ask your notes: question → FTS retrieval → numbered excerpts → inline AI
 * answer with clickable citations. Single-shot per question; the source
 * list is what was fed to the model, so citations are always real notes.
 */
export function AskPanel({ dir, search, onOpen }: Props) {
  const [question, setQuestion] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const thinking = phase.kind === "thinking";
  const q = question.trim();

  const ask = async () => {
    if (thinking || !q) return;
    setPhase({ kind: "thinking" });
    try {
      const hits = await search(q);
      const sources = await retrieveSources(hits, async (path) => {
        try {
          return await invoke<string>("note_read", { dir, path });
        } catch {
          return null; // deleted between search and read — skip it
        }
      });
      if (sources.length === 0) {
        setPhase({ kind: "empty", question: q });
        return;
      }

      const providers = await invoke<AgentProviderInfo[]>("agent_detect");
      const provider = pickAiProvider(providers, readAgentProvider("opencode"));
      if (!provider) {
        setPhase({
          kind: "hint",
          hint: providers[0]?.installHint ?? "install opencode, codex, or Claude Code",
        });
        return;
      }
      const result = await runAiText({
        dir,
        provider: provider.id,
        instruction: ASK_INSTRUCTION,
        context: `Question: ${q}\n\n${buildContext(sources)}`,
      });
      const answer = result.text.trim();
      if (result.status === "cancelled") {
        setPhase({ kind: "idle" });
        return;
      }
      if (!answer) {
        setPhase({
          kind: "hint",
          hint:
            result.status === "timeout"
              ? "the AI timed out — try again"
              : "the AI returned an empty reply",
        });
        return;
      }
      setPhase({ kind: "answer", question: q, answer, sources });
    } catch (e) {
      setPhase({ kind: "hint", hint: errorMessage(e) });
    }
  };

  const stop = () => {
    void stopAi();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="Ask" />
      <form
        className="flex gap-2 border-b border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask your notes…"
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
          aria-label="Question"
        />
        {thinking ? (
          <button type="button" className={btn} onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" className={btn} disabled={!q}>
            Ask
          </button>
        )}
      </form>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-xs">
        {phase.kind === "thinking" && (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <Sparkles className="size-3.5 animate-pulse text-primary" aria-hidden />
            Searching notes and thinking…
          </p>
        )}

        {phase.kind === "empty" && (
          <p className="flex items-start gap-1.5 text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden />
            <span>
              No notes match “{phase.question}”. Ask again with different words — I only answer from
              notes that exist in this vault.
            </span>
          </p>
        )}

        {phase.kind === "hint" && (
          <div>
            <p className="flex items-start gap-1.5 text-muted-foreground">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden />
              {phase.hint}
            </p>
            <div className="mt-2 flex justify-end">
              <button type="button" className={btn} onClick={() => setPhase({ kind: "idle" })}>
                <X className="size-3.5" aria-hidden /> Dismiss
              </button>
            </div>
          </div>
        )}

        {phase.kind === "answer" && (
          <div>
            <p className="mb-2 text-muted-foreground">“{phase.question}”</p>
            <p className="whitespace-pre-wrap leading-relaxed">{phase.answer}</p>
            <p className="mt-4 mb-1 font-medium text-muted-foreground">Sources</p>
            <ul className="space-y-1">
              {phase.sources.map((s) => (
                <li key={s.n}>
                  <button
                    type="button"
                    className="flex w-full items-baseline gap-2 rounded-md px-1 py-0.5 text-left hover:bg-accent"
                    onClick={() => onOpen(s.path)}
                    title={s.excerpt}
                  >
                    <span className="shrink-0 font-mono text-[10px] text-primary">[{s.n}]</span>
                    <span className="min-w-0 flex-1 truncate">{fileName(s.path)}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      L{s.line}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

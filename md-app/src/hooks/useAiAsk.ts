import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../lib/ipc";
import { AGENT_PROVIDER_KEY, type AgentProviderId, type AgentProviderInfo } from "../lib/agent";

export type AiAskPhase =
  | { kind: "idle" }
  | { kind: "running"; question: string; streamed: string }
  | { kind: "answer"; question: string; answer: string }
  | { kind: "error"; message: string };

/**
 * Ask-your-notes: one `ai_ask` run per question. The command layer retrieves
 * excerpts from the vault (FTS5), fences them as data, and instructs the
 * model to cite them; this hook only transports the question and the
 * streamed answer.
 */
export function useAiAsk(args: { dir: string }) {
  const [phase, setPhase] = useState<AiAskPhase>({ kind: "idle" });
  const [providers, setProviders] = useState<AgentProviderInfo[]>([]);
  const [selected, setSelected] = useState<AgentProviderId | null>(null);
  const lastQuestion = useRef<string | null>(null);

  useEffect(() => {
    void invoke<AgentProviderInfo[]>("agent_detect")
      .then((list) => {
        setProviders(list);
        let wanted: AgentProviderId | null = null;
        try {
          const v = localStorage.getItem(AGENT_PROVIDER_KEY);
          if (v === "opencode" || v === "codex" || v === "claude") wanted = v;
        } catch {
          /* private mode */
        }
        const pick =
          list.find((p) => p.id === wanted && p.available) ?? list.find((p) => p.available);
        if (pick) setSelected(pick.id as AgentProviderId);
      })
      .catch(() => setProviders([]));
  }, []);

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!selected || q === "" || phase.kind === "running") return;
      lastQuestion.current = q;
      setPhase({ kind: "running", question: q, streamed: "" });

      const channel = new Channel<{ kind: "output"; stream: string; text: string }>();
      channel.onmessage = (event) => {
        if (event.stream !== "stdout") return;
        setPhase((prev) =>
          prev.kind === "running" ? { ...prev, streamed: prev.streamed + event.text } : prev,
        );
      };
      try {
        const result = await invoke<{ status: string; text: string }>("ai_ask", {
          dir: args.dir,
          provider: selected,
          question: q,
          options: {},
          onEvent: channel,
        });
        if (result.status === "done" && result.text.trim() !== "") {
          setPhase({ kind: "answer", question: q, answer: result.text });
        } else if (result.status === "cancelled") {
          setPhase({ kind: "idle" });
        } else {
          setPhase({
            kind: "error",
            message:
              result.status === "timeout"
                ? "The assistant ran out of time — try a narrower question."
                : "The assistant returned no answer.",
          });
        }
      } catch (e) {
        setPhase({ kind: "error", message: errorMessage(e) });
      }
    },
    [args.dir, selected, phase.kind],
  );

  const stop = useCallback(async () => {
    try {
      await invoke("ai_stop");
    } catch {
      /* already stopped or never started */
    }
  }, []);

  const dismiss = useCallback(() => setPhase({ kind: "idle" }), []);

  const provider = providers.find((p) => p.id === selected)?.label ?? null;

  return { phase, provider, ask, stop, dismiss };
}

export type AiAsk = ReturnType<typeof useAiAsk>;

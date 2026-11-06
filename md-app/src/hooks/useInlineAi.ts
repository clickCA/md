import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../lib/ipc";
import {
  type InlineAiOp,
  instructionFor,
  isProposalStale,
  unwrapCandidate,
} from "../lib/inline-ai";
import { AGENT_PROVIDER_KEY, type AgentProviderId, type AgentProviderInfo } from "../lib/agent";

/** The editor selection snapshot a request is built from (the ADR's
    (document version, span) capture — accept only applies when both still
    hold). */
export interface InlineSelection {
  text: string;
  from: number;
  to: number;
  version: number;
}

export type InlineAiPhase =
  | { kind: "idle" }
  | { kind: "running"; op: InlineAiOp; streamed: string }
  | {
      kind: "preview";
      op: InlineAiOp;
      candidate: string;
      selectionText: string;
      from: number;
      to: number;
      version: number;
    }
  | { kind: "error"; message: string };

export interface InlineAiProvider {
  id: AgentProviderId;
  label: string;
}

/**
 * Drives one inline AI request at a time against the installed coding-agent
 * CLIs (see docs/adr/2026-11-06-inline-ai-surface.md). The hook never
 * writes the document: Accept hands the candidate to the caller's apply()
 * (an editor transaction), Reject/stop simply drop it. A proposal whose
 * document version moved is flagged stale and cannot be accepted.
 */
export function useInlineAi(args: {
  dir: string;
  getSelection: () => InlineSelection | null;
  getVersion: () => number;
  apply: (from: number, to: number, text: string) => void;
}) {
  const [phase, setPhase] = useState<InlineAiPhase>({ kind: "idle" });
  const [providers, setProviders] = useState<AgentProviderInfo[]>([]);
  const [selected, setSelected] = useState<AgentProviderId | null>(null);
  const lastOp = useRef<InlineAiOp | null>(null);

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

  const stale = phase.kind === "preview" && isProposalStale(phase.version, args.getVersion());

  const run = useCallback(
    async (op: InlineAiOp) => {
      const provider = selected;
      const sel = args.getSelection();
      if (!provider || !sel || sel.text.trim() === "") return;
      lastOp.current = op;
      setPhase({ kind: "running", op, streamed: "" });

      // The command layer composes the prompt (instruction + context-as-data
      // + reply-only contract) — we send the parts.
      const channel = new Channel<{ kind: "output"; stream: string; text: string }>();
      channel.onmessage = (event) => {
        if (event.stream !== "stdout") return; // stderr is CLI diagnostics
        setPhase((prev) =>
          prev.kind === "running" ? { ...prev, streamed: prev.streamed + event.text } : prev,
        );
      };
      try {
        const result = await invoke<{
          status: "done" | "cancelled" | "timeout";
          text: string;
        }>("ai_text", {
          dir: args.dir,
          provider,
          instruction: instructionFor(op),
          options: { context: sel.text },
          onEvent: channel,
        });
        if (result.status === "done" && result.text.trim() !== "") {
          setPhase({
            kind: "preview",
            op,
            candidate: unwrapCandidate(result.text, sel.text),
            selectionText: sel.text,
            from: sel.from,
            to: sel.to,
            version: sel.version,
          });
        } else if (result.status === "cancelled") {
          setPhase({ kind: "idle" });
        } else if (result.status === "timeout") {
          setPhase({
            kind: "error",
            message:
              result.text.trim() !== ""
                ? "The assistant ran out of time. Partial reply was kept out of caution — regenerate to try again."
                : "The assistant ran out of time without replying.",
          });
        } else {
          setPhase({
            kind: "error",
            message: "The assistant returned nothing to apply.",
          });
        }
      } catch (e) {
        setPhase({ kind: "error", message: errorMessage(e) });
      }
    },
    [args, selected],
  );

  const accept = useCallback(() => {
    if (phase.kind !== "preview" || isProposalStale(phase.version, args.getVersion())) return;
    args.apply(phase.from, phase.to, phase.candidate);
    setPhase({ kind: "idle" });
  }, [args, phase]);

  const reject = useCallback(() => setPhase({ kind: "idle" }), []);

  const stop = useCallback(async () => {
    try {
      await invoke("ai_stop");
    } catch {
      /* already stopped or never started */
    }
  }, []);

  /** Re-run the last operation against the current selection. */
  const regenerate = useCallback(() => {
    if (!lastOp.current) return;
    void run(lastOp.current);
  }, [run]);

  /** Forget any in-flight proposal — the editor is switching files. */
  const reset = useCallback(() => setPhase({ kind: "idle" }), []);

  const provider: InlineAiProvider | null = (() => {
    const p = providers.find((x) => x.id === selected);
    return p ? { id: p.id as AgentProviderId, label: p.label } : null;
  })();

  return {
    phase,
    stale,
    provider,
    running: phase.kind === "running",
    hasCandidate: phase.kind === "preview",
    run,
    accept,
    reject,
    stop,
    regenerate,
    reset,
  };
}

export type InlineAi = ReturnType<typeof useInlineAi>;

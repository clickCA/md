import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../lib/ipc";
import { buildNoteInstruction, notePathFromContent } from "../lib/ai-note";
import { AGENT_PROVIDER_KEY, type AgentProviderId, type AgentProviderInfo } from "../lib/agent";

export type AiNotePhase =
  { kind: "idle" } | { kind: "running"; streamed: string } | { kind: "error"; message: string };

/**
 * Drives "create a note from a description": one `ai_text` run composes the
 * content, the hook derives a unique path from the H1 and writes it through
 * the normal `note_write` path, then hands the path to the caller to open.
 * Cancelling or failing writes nothing.
 */
export function useAiNote(args: { dir: string; onCreated: (path: string) => void }) {
  const [phase, setPhase] = useState<AiNotePhase>({ kind: "idle" });
  const [providers, setProviders] = useState<AgentProviderInfo[]>([]);
  const [selected, setSelected] = useState<AgentProviderId | null>(null);
  const existing = useRef<string[]>([]);

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

  const syncExisting = useCallback(async () => {
    try {
      existing.current = await invoke<string[]>("note_list", { dir: args.dir });
    } catch {
      existing.current = [];
    }
  }, [args.dir]);

  const create = useCallback(
    async (description: string) => {
      if (!selected || description.trim() === "" || phase.kind === "running") return;
      setPhase({ kind: "running", streamed: "" });
      await syncExisting();

      const channel = new Channel<{ kind: "output"; stream: string; text: string }>();
      channel.onmessage = (event) => {
        if (event.stream !== "stdout") return;
        setPhase((prev) =>
          prev.kind === "running" ? { ...prev, streamed: prev.streamed + event.text } : prev,
        );
      };
      try {
        const result = await invoke<{ status: string; text: string }>("ai_text", {
          dir: args.dir,
          provider: selected,
          instruction: buildNoteInstruction(description),
          options: {},
          onEvent: channel,
        });
        if (result.status !== "done" || result.text.trim() === "") {
          setPhase({
            kind: "error",
            message:
              result.status === "cancelled"
                ? "Cancelled — nothing was written."
                : "The assistant did not return a note.",
          });
          return;
        }
        const path = notePathFromContent(result.text, existing.current);
        await invoke("note_write", { dir: args.dir, path, content: result.text });
        setPhase({ kind: "idle" });
        args.onCreated(path);
      } catch (e) {
        setPhase({ kind: "error", message: errorMessage(e) });
      }
    },
    [args, selected, phase.kind, syncExisting],
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

  return { phase, provider, create, stop, dismiss };
}

export type AiNote = ReturnType<typeof useAiNote>;

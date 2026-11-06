import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../lib/ipc";
import {
  type AgentProviderId,
  type AgentProviderInfo,
  type AgentEvent,
  type AgentRunResult,
  type AgentTurn,
  readAgentProvider,
  readAutoApprove,
} from "../lib/agent";

const PREFERRED_PROVIDER: AgentProviderId = "opencode";

/**
 * Drives the AI agent panel: discovers the installed CLIs, runs one agent
 * turn at a time against the vault directory, streams output through a Tauri
 * channel, and hands completed turns (with the files they touched) back to
 * the caller. All provider auth lives in the CLI's own HOME config — Quire
 * never sees or stores credentials.
 *
 * Session continuity is best-effort per provider: Claude Code returns an
 * explicit session id that we resume; opencode/codex continue their most
 * recent session in the directory instead. "New session" forgets both.
 */
export function useAgent(dir: string, onTurnFinished?: (changed: string[]) => void) {
  const [providers, setProviders] = useState<AgentProviderInfo[]>([]);
  const [selected, setSelected] = useState<AgentProviderId>(() =>
    readAgentProvider(PREFERRED_PROVIDER),
  );
  const [autoApprove, setAutoApprove] = useState<boolean>(() => readAutoApprove(true));
  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");

  const idRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  const onTurnFinishedRef = useRef(onTurnFinished);
  useEffect(() => {
    onTurnFinishedRef.current = onTurnFinished;
  });

  useEffect(() => {
    void invoke<AgentProviderInfo[]>("agent_detect")
      .then(setProviders)
      .catch(() => setProviders([]));
  }, []);

  // Keep the choice valid: if the preferred agent isn't installed, fall back
  // to the first one that is.
  useEffect(() => {
    if (providers.length === 0) return;
    const chosen = providers.find((p) => p.id === selected);
    if (chosen?.available) return;
    const first = providers.find((p) => p.available);
    if (first && first.id !== selected) setSelected(first.id);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, selected]);

  const persistProvider = (id: AgentProviderId) => {
    setSelected(id);
    try {
      localStorage.setItem("quire.agent-provider", id);
    } catch {
      /* private mode — session-only */
    }
  };

  const persistAutoApprove = (on: boolean) => {
    setAutoApprove(on);
    try {
      localStorage.setItem("quire.agent-autoapprove", on ? "1" : "0");
    } catch {
      /* private mode — session-only */
    }
  };

  const run = useCallback(
    async (rawPrompt: string) => {
      const prompt = rawPrompt.trim();
      if (!prompt || running) return;

      const provider = providers.find((p) => p.id === selected)?.available ? selected : null;
      if (!provider) {
        setError("No coding agent CLI is installed — see the panel for install hints.");
        return;
      }

      const id = ++idRef.current;
      const turn: AgentTurn = {
        id,
        provider,
        prompt,
        output: "",
        status: "running",
        summary: null,
        changedFiles: [],
      };
      setTurns((prev) => [...prev, turn]);
      setRunning(true);
      setError(null);
      setInput("");

      // Is this a follow-up inside the same panel conversation?
      const resumeSessionId = sessionIdRef.current ?? undefined;
      const channel = new Channel<AgentEvent>();
      channel.onmessage = (event) => {
        if (event.kind === "output") {
          setTurns((prev) =>
            prev.map((t) => (t.id === id ? { ...t, output: t.output + event.text + "\n" } : t)),
          );
        }
      };

      try {
        const result = await invoke<AgentRunResult>("agent_run", {
          dir,
          provider,
          prompt,
          options: {
            autoApprove,
            continueSession: !resumeSessionId && turns.length > 0,
            resumeSessionId,
          },
          onEvent: channel,
        });
        if (result.sessionId) sessionIdRef.current = result.sessionId;
        setTurns((prev) =>
          prev.map((t) =>
            t.id === id
              ? {
                  ...t,
                  status: result.status,
                  summary: result.summary,
                  changedFiles: result.changedFiles,
                }
              : t,
          ),
        );
        onTurnFinishedRef.current?.(result.changedFiles);
      } catch (e) {
        const message = errorMessage(e);
        setTurns((prev) =>
          prev.map((t) => (t.id === id ? { ...t, status: "error", error: message } : t)),
        );
        setError(message);
      } finally {
        setRunning(false);
      }
    },
    [dir, selected, providers, autoApprove, running, turns.length],
  );

  const stop = useCallback(async () => {
    try {
      await invoke("agent_stop");
    } catch {
      /* already stopped or never started */
    }
  }, []);

  const newSession = useCallback(() => {
    sessionIdRef.current = null;
    setTurns([]);
    setError(null);
    setInput("");
  }, []);

  return {
    providers,
    selected,
    setSelected: persistProvider,
    autoApprove,
    setAutoApprove: persistAutoApprove,
    turns,
    running,
    error,
    input,
    setInput,
    run,
    stop,
    newSession,
  };
}

export type Agent = ReturnType<typeof useAgent>;

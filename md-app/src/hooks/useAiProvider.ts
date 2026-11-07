import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pickAiProvider } from "@/lib/ai";
import { AGENT_PROVIDER_KEY, type AgentProviderId, type AgentProviderInfo } from "@/lib/agent";

/**
 * Which installed agent CLI runs inline AI for this user: the provider picked
 * in the agent panel when available, else the first one on PATH. Shared by the
 * AI surfaces that only need a label + id (folder summaries today).
 */
export function useAiProvider() {
  const [providers, setProviders] = useState<AgentProviderInfo[]>([]);

  useEffect(() => {
    void invoke<AgentProviderInfo[]>("agent_detect")
      .then(setProviders)
      .catch(() => setProviders([]));
  }, []);

  const chosen = useMemo(() => {
    let preferred: AgentProviderId | null = null;
    try {
      const v = localStorage.getItem(AGENT_PROVIDER_KEY);
      if (v === "opencode" || v === "codex" || v === "claude") preferred = v;
    } catch {
      /* private mode — session-only */
    }
    return pickAiProvider(providers, preferred);
  }, [providers]);

  return {
    selected: (chosen?.id as AgentProviderId | undefined) ?? null,
    label: chosen?.label ?? null,
  };
}

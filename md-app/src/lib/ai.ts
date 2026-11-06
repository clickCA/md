/**
 * Inline AI (selection text operations) — wire types + thin invoke wrappers.
 * Contract: docs/api.md § Inline AI (text); DTOs mirror `commands/ai.rs`.
 *
 * The inline surface NEVER modifies the vault: `ai_text` returns a candidate
 * replacement string and the editor decides what happens to it (diff preview
 * → accept/reject), per ADR 2026-11-06-inline-ai-surface.md.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import type { AgentProviderId, AgentProviderInfo } from "@/lib/agent";

/** One streamed chunk from the running CLI (reply text or diagnostics). */
export type AiEvent = { kind: "output"; stream: "stdout" | "stderr"; text: string };

export interface AiTextResult {
  status: "done" | "cancelled" | "timeout";
  text: string;
  durationMs: number;
}

export interface AiTextArgs {
  dir: string;
  provider: AgentProviderId;
  instruction: string;
  /** Note content fenced off as data (the selection being rewritten). */
  context?: string;
  /** Called per streamed stdout chunk while the run is in flight. */
  onChunk?: (text: string) => void;
}

export async function runAiText(args: AiTextArgs): Promise<AiTextResult> {
  const channel = new Channel<AiEvent>();
  channel.onmessage = (event) => {
    if (event.kind === "output" && event.stream === "stdout") args.onChunk?.(event.text);
  };
  return invoke<AiTextResult>("ai_text", {
    dir: args.dir,
    provider: args.provider,
    instruction: args.instruction,
    options: { context: args.context },
    onEvent: channel,
  });
}

export async function stopAi(): Promise<void> {
  try {
    await invoke("ai_stop");
  } catch {
    /* never started or already stopped */
  }
}

/**
 * Which CLI runs inline AI: the provider the user picked for the agent
 * panel when it is installed, otherwise the first available one. `null`
 * when no CLI is on PATH — the UI shows an install hint, never an error.
 */
export function pickAiProvider(
  providers: AgentProviderInfo[],
  preferred: AgentProviderId | null,
): AgentProviderInfo | null {
  if (preferred) {
    const match = providers.find((p) => p.id === preferred && p.available);
    if (match) return match;
  }
  return providers.find((p) => p.available) ?? null;
}

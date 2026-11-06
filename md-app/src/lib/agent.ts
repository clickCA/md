/**
 * Coding-agent integration — types + pure helpers shared by the agent hook
 * and the AI agent panel. The wire contract lives in `docs/api.md`; these
 * interfaces mirror the Rust DTOs in `commands/agent.rs`.
 */

export type AgentProviderId = "opencode" | "codex" | "claude";

export interface AgentProviderInfo {
  id: AgentProviderId;
  label: string;
  available: boolean;
  installHint: string;
}

/** One chunk streamed from the running CLI over the Tauri channel. */
export type AgentEvent =
  | { kind: "output"; stream: "stdout" | "stderr"; text: string }
  | { kind: "tool"; name: string; detail: string };

/** A tool call the agent made, normalized across providers by the backend. */
export interface AgentToolCall {
  name: string;
  detail: string;
}

/** `name · detail` for the activity log, or just the name when no detail. */
export function toolLabel(call: AgentToolCall): string {
  return call.detail ? `${call.name} · ${call.detail}` : call.name;
}

export interface AgentRunOptions {
  autoApprove: boolean;
  continueSession: boolean;
  resumeSessionId?: string;
}

export interface AgentRunResult {
  status: "done" | "cancelled" | "error";
  changedFiles: string[];
  sessionId: string | null;
  summary: string | null;
  durationMs: number;
}

/** A finished (or in-flight) exchange with the agent, for the panel. */
export interface AgentTurn {
  id: number;
  provider: AgentProviderId;
  prompt: string;
  /** Assistant text output, exactly as the CLI produced it. */
  output: string;
  /** Tool calls observed while the turn ran (file edits, commands, …). */
  toolCalls: AgentToolCall[];
  status: "running" | "done" | "cancelled" | "error";
  error?: string;
  summary?: string | null;
  changedFiles: string[];
}

export const AGENT_PROVIDER_KEY = "quire.agent-provider";
export const AGENT_AUTOAPPROVE_KEY = "quire.agent-autoapprove";

export function readAgentProvider(defaultId: AgentProviderId): AgentProviderId {
  try {
    const v = localStorage.getItem(AGENT_PROVIDER_KEY);
    if (v === "opencode" || v === "codex" || v === "claude") return v;
  } catch {
    /* private mode — session-only */
  }
  return defaultId;
}

export function readAutoApprove(defaultValue: boolean): boolean {
  try {
    const v = localStorage.getItem(AGENT_AUTOAPPROVE_KEY);
    if (v !== null) return v !== "0";
  } catch {
    /* private mode — session-only */
  }
  return defaultValue;
}

/**
 * The agent-changed paths that are real, openable notes in the vault right
 * now. Intersects the CLI's `git status` report with the current vault file
 * set, so a chip is never rendered for a deleted or non-note file.
 */
export function openableChangedFiles(changed: string[], files: { path: string }[]): string[] {
  const known = new Set(files.map((f) => f.path));
  return changed.filter((p) => known.has(p));
}

/** File-basename used by the change chips (drops the .md suffix). */
export function chipName(path: string): string {
  return path.split("/").pop()!.replace(/\.md$/, "");
}

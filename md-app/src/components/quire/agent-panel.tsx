import { useEffect, useRef } from "react";
import { ArrowUp, RotateCcw, ShieldCheck, Sparkles, Square, Wrench } from "lucide-react";
import type { AgentProviderId, AgentTurn } from "@/lib/agent";
import { chipName, openableChangedFiles, toolLabel } from "@/lib/agent";
import type { AgentProviderInfo } from "@/lib/agent";
import { cn } from "@/lib/utils";
import { IconButton } from "./sidebar";
import { PanelHeader } from "./panel-header";

type Props = {
  providers: AgentProviderInfo[];
  selected: AgentProviderId;
  onSelect: (id: AgentProviderId) => void;
  running: boolean;
  turns: AgentTurn[];
  error: string | null;
  input: string;
  onInput: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onNewSession: () => void;
  autoApprove: boolean;
  onAutoApproveChange: (on: boolean) => void;
  /** Current vault files — change chips only open paths that exist here. */
  files: { path: string }[];
  onOpenFile: (path: string) => void;
};

export type AgentPanelProps = Props;

const STATUS_LABEL: Record<AgentTurn["status"], string> = {
  running: "Running…",
  done: "Done",
  cancelled: "Cancelled",
  error: "Failed",
};

export function AgentPanel({
  providers,
  selected,
  onSelect,
  running,
  turns,
  error,
  input,
  onInput,
  onSend,
  onStop,
  onNewSession,
  autoApprove,
  onAutoApproveChange,
  files,
  onOpenFile,
}: Props) {
  const anyAvailable = providers.some((p) => p.available);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the latest agent output in view as it streams.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const send = () => {
    if (!running && input.trim()) onSend();
  };

  return (
    <aside
      aria-label="AI agent"
      className="hidden w-80 shrink-0 flex-col border-l border-border bg-sidebar lg:flex"
    >
      <PanelHeader title="AI agent">
        {providers.length === 0 ? (
          <span className="pr-2 font-mono text-[11px] text-muted-foreground">scanning…</span>
        ) : (
          <select
            aria-label="Coding agent CLI"
            value={selected}
            disabled={running}
            onChange={(e) => onSelect(e.target.value as AgentProviderId)}
            className="h-6 rounded border border-border bg-background pr-1 pl-1.5 text-[11px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available}>
                {p.available ? p.label : `${p.label} — not installed`}
              </option>
            ))}
          </select>
        )}
      </PanelHeader>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pt-1 pb-2">
        {error && (
          <div
            role="status"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] leading-snug text-destructive"
          >
            {error}
          </div>
        )}

        {!anyAvailable && providers.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="flex size-9 items-center justify-center rounded-md bg-accent">
              <Sparkles className="size-4 text-primary" aria-hidden />
            </div>
            <h3 className="text-[13px] font-medium">No coding agent installed</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              The panel runs a coding-agent CLI (opencode, Claude Code, codex) against your vault
              folder and streams its output here. Install one, sign in once from a terminal, and it
              appears here automatically.
            </p>
            <ul className="space-y-1.5">
              {providers.map((p) => (
                <li
                  key={p.id}
                  className="rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground"
                >
                  <span className="font-mono text-foreground">{p.label}</span>
                  <span className="block font-mono text-[10px] leading-relaxed opacity-80">
                    {p.installHint}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {turns.length === 0 && anyAvailable && (
          <div className="flex flex-col gap-2 text-xs leading-relaxed text-muted-foreground">
            <p>
              Ask a coding agent to help with this vault — write a note, restructure notes, fix
              formatting, or handle code stored here. The agent edits files in your vault folder;
              review its changes in the <span className="text-foreground">Source control</span>{" "}
              panel before syncing.
            </p>
            <p className="font-mono text-[11px] opacity-70">
              Auth comes from the CLI itself (your existing opencode / Claude Code login) — no keys
              stored here.
            </p>
          </div>
        )}

        <ol className="space-y-3">
          {turns.map((turn) => {
            const openable = openableChangedFiles(turn.changedFiles, files);
            return (
              <li key={turn.id} className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Sparkles className="size-3 text-primary" aria-hidden />
                  <span className="font-medium text-foreground">You</span>
                  <span className="uppercase tracking-wide">· {turn.provider}</span>
                  <span
                    className={cn(
                      "ml-auto font-mono",
                      turn.status === "running"
                        ? "text-primary"
                        : turn.status === "error"
                          ? "text-destructive"
                          : turn.status === "cancelled"
                            ? "text-muted-foreground"
                            : "text-muted-foreground",
                    )}
                  >
                    {STATUS_LABEL[turn.status]}
                  </span>
                </div>

                <p className="rounded-md bg-accent/50 px-2 py-1.5 text-[13px] whitespace-pre-wrap text-foreground">
                  {turn.prompt}
                </p>

                {turn.output.trim() !== "" && (
                  <pre className="overflow-x-auto rounded-md border border-border px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
                    {turn.output}
                  </pre>
                )}

                {turn.toolCalls.length > 0 && (
                  <div>
                    <span className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                      Activity
                    </span>
                    <ul className="mt-1 space-y-0.5">
                      {turn.toolCalls.map((call, i) => (
                        <li
                          key={`${i}-${call.name}`}
                          title={toolLabel(call)}
                          className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
                        >
                          <Wrench className="size-3 shrink-0 opacity-70" aria-hidden />
                          <span className="truncate">{toolLabel(call)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {turn.summary && (
                  <p className="font-mono text-[11px] text-muted-foreground">{turn.summary}</p>
                )}

                {turn.error && (
                  <p className="text-[11px] text-destructive" role="alert">
                    {turn.error}
                  </p>
                )}

                {openable.length > 0 && (
                  <div>
                    <span className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                      Changed files
                    </span>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {openable.map((path) => (
                        <button
                          key={path}
                          type="button"
                          onClick={() => onOpenFile(path)}
                          title={path}
                          className="flex h-6 max-w-full items-center gap-1 rounded border border-border px-1.5 font-mono text-[11px] text-foreground hover:bg-accent"
                        >
                          <span className="truncate">{chipName(path)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      <div className="shrink-0 space-y-1.5 border-t border-border p-2">
        <div className="flex items-end gap-1.5">
          <textarea
            value={input}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={anyAvailable ? "Ask the agent…" : "Install a coding agent CLI first"}
            rows={2}
            disabled={running || !anyAvailable}
            aria-label="Prompt the coding agent"
            className="min-h-9 flex-1 resize-none rounded-md border border-border bg-background px-2 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
          />
          {running ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop agent"
              title="Stop"
              className="flex size-9 shrink-0 items-center justify-center rounded-md bg-destructive text-destructive-foreground hover:opacity-90"
            >
              <Square className="size-3.5" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!input.trim() || !anyAvailable}
              aria-label="Send prompt"
              title="Send prompt (Enter)"
              className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
            >
              <ArrowUp className="size-3.5" aria-hidden />
            </button>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <label className="flex min-w-0 cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground select-none">
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={(e) => onAutoApproveChange(e.target.checked)}
              disabled={running || !anyAvailable}
              className="size-3 accent-primary"
            />
            <ShieldCheck className="size-3 shrink-0" aria-hidden />
            <span className="truncate">Auto-approve edits</span>
          </label>
          <IconButton label="New session" onClick={onNewSession} pressed={false}>
            <RotateCcw className="size-3.5" aria-hidden />
          </IconButton>
        </div>
      </div>
    </aside>
  );
}

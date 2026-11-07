import { useCallback, useRef, useState } from "react";
import { runAiText, stopAi } from "@/lib/ai";
import {
  buildSummaryContext,
  buildSummaryInstruction,
  folderNotes,
  summaryNotePath,
} from "@/lib/folder-summary";
import { errorMessage } from "@/lib/ipc";
import type { VaultFile } from "@/lib/vault";
import { useAiProvider } from "./useAiProvider";

/**
 * What a folder-summary run is doing. `review` is the preview: the generated
 * markdown exists only in memory until the caller's `onWrite` (the normal note
 * write path) runs on Accept — no write without accept, same rule as the
 * selection-AI diff preview.
 */
export type FolderSummaryPhase =
  | { kind: "idle" }
  | { kind: "running"; folder: string; streamed: string; scope: number }
  | { kind: "review"; folder: string; content: string; path: string; scope: number }
  | { kind: "error"; folder: string; message: string };

export function useFolderSummary(args: {
  dir: string;
  files: VaultFile[];
  /** Normal note-write path (git + index see an ordinary new note). */
  onWrite: (path: string, content: string) => Promise<void> | void;
}) {
  const [phase, setPhase] = useState<FolderSummaryPhase>({ kind: "idle" });
  const provider = useAiProvider();
  const live = useRef(false);

  const summarize = useCallback(
    async (folder: string) => {
      const notes = folderNotes(args.files, folder);
      if (!provider.selected) {
        setPhase({
          kind: "error",
          folder,
          message:
            "No AI CLI found — install opencode, Claude Code or codex to summarize a folder.",
        });
        return;
      }
      if (notes.length === 0) {
        setPhase({ kind: "error", folder, message: "This folder has no notes to summarize." });
        return;
      }
      const context = buildSummaryContext(notes);
      live.current = true;
      setPhase({ kind: "running", folder, streamed: "", scope: notes.length });
      try {
        const result = await runAiText({
          dir: args.dir,
          provider: provider.selected,
          instruction: buildSummaryInstruction(folder, context.included, context.total),
          context: context.text,
          onChunk: (text) =>
            setPhase((prev) =>
              prev.kind === "running" ? { ...prev, streamed: prev.streamed + text } : prev,
            ),
        });
        if (!live.current) return; // stopped or dismissed mid-run
        if (result.status !== "done" || result.text.trim() === "") {
          setPhase({
            kind: "error",
            folder,
            message:
              result.status === "cancelled"
                ? "Cancelled — nothing was written."
                : "The assistant did not return a summary.",
          });
          return;
        }
        setPhase({
          kind: "review",
          folder,
          content: result.text.trim(),
          path: summaryNotePath(
            folder,
            args.files.map((f) => f.path),
          ),
          scope: notes.length,
        });
      } catch (e) {
        setPhase({ kind: "error", folder, message: errorMessage(e) });
      } finally {
        live.current = false;
      }
    },
    [args.dir, args.files, provider.selected],
  );

  const accept = useCallback(
    async (content: string) => {
      if (phase.kind !== "review" || content.trim() === "") return;
      const { path } = phase;
      setPhase({ kind: "idle" });
      await args.onWrite(path, content);
    },
    [phase, args],
  );

  const stop = useCallback(async () => {
    live.current = false;
    await stopAi();
    setPhase({ kind: "idle" });
  }, []);

  const dismiss = useCallback(() => {
    live.current = false;
    setPhase({ kind: "idle" });
  }, []);

  return { phase, provider: provider.label, summarize, accept, stop, dismiss };
}

export type FolderSummary = ReturnType<typeof useFolderSummary>;

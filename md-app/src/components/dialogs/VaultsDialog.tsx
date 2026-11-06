import { Dialog } from "@base-ui/react/dialog";
import { FolderPlus, GitFork } from "lucide-react";
import Modal from "../ui/Modal";
import type { VaultInfo } from "../../types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vaults: VaultInfo[];
  busy: boolean;
  onOpen: (dir: string) => void;
  onAdd: () => void;
}

/** Mobile-only vault picker: the sandboxed vaults that exist on this device. */
export default function VaultsDialog({ open, onOpenChange, vaults, busy, onOpen, onAdd }: Props) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} className="top-24 w-96 max-w-[92vw]">
      <Dialog.Title className="mb-3 text-sm font-semibold">Vaults</Dialog.Title>

      {vaults.length === 0 ? (
        <p className="mb-4 text-xs text-muted-foreground">
          No vaults on this device yet — create one or clone from a git URL.
        </p>
      ) : (
        <ul className="mb-4 max-h-72 space-y-1 overflow-y-auto">
          {vaults.map((v) => (
            <li key={v.dir}>
              <button
                type="button"
                disabled={busy}
                onClick={() => onOpen(v.dir)}
                className="w-full rounded-md border border-border bg-muted/40 px-2.5 py-2 text-left hover:bg-accent disabled:opacity-40"
              >
                <span className="block truncate text-sm font-medium text-foreground">{v.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {v.remoteUrl ?? "local vault"}
                  {v.noteCount != null ? ` · ${v.noteCount} notes` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end gap-2">
        <Dialog.Close className="rounded-md px-2.5 py-1 text-xs hover:bg-accent">
          Close
        </Dialog.Close>
        <button
          onClick={onAdd}
          className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground hover:opacity-90"
        >
          {vaults.length === 0 ? (
            <>
              <FolderPlus className="size-3.5" aria-hidden /> Create a vault
            </>
          ) : (
            <>
              <GitFork className="size-3.5" aria-hidden /> Add…
            </>
          )}
        </button>
      </div>
    </Modal>
  );
}

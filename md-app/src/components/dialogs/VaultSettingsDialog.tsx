import { Dialog } from "@base-ui/react/dialog";
import { FolderOpen } from "lucide-react";
import Modal from "../ui/Modal";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dir: string;
  remote: string;
  onRemoteChange: (value: string) => void;
  onChooseFolder: () => void;
  onSave: () => void;
  busy: boolean;
}

export default function VaultSettingsDialog({
  open,
  onOpenChange,
  dir,
  remote,
  onRemoteChange,
  onChooseFolder,
  onSave,
  busy,
}: Props) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} className="top-1/4 w-96 max-w-[92vw]">
      <Dialog.Title className="mb-3 text-sm font-semibold">Vault</Dialog.Title>
      <label className="mb-1 block text-xs text-muted-foreground">folder</label>
      <div className="mb-3 flex gap-2">
        <input
          value={dir}
          readOnly
          className="min-w-0 flex-1 rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-muted-foreground outline-none"
        />
        <button
          onClick={onChooseFolder}
          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
        >
          <FolderOpen size={13} /> Choose…
        </button>
      </div>
      <label className="mb-1 block text-xs text-muted-foreground">
        git remote (optional — leave empty for a local-only vault)
      </label>
      <input
        value={remote}
        onChange={(e) => onRemoteChange(e.target.value)}
        placeholder="https://github.com/you/notes.git"
        className="mb-4 w-full rounded-md border border-input bg-muted px-2 py-1.5 text-sm outline-none focus:border-primary/60"
      />
      <div className="flex justify-end gap-2">
        <Dialog.Close className="rounded-md px-2.5 py-1 text-xs hover:bg-accent">Cancel</Dialog.Close>
        <button
          onClick={onSave}
          disabled={busy}
          className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </Modal>
  );
}

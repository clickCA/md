import { Dialog } from "@base-ui/react/dialog";
import Modal from "../ui/Modal";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dir: string;
  remote: string;
  onRemoteChange: (value: string) => void;
  onCreate: () => void;
  busy: boolean;
}

export default function VaultSetupDialog({
  open,
  onOpenChange,
  dir,
  remote,
  onRemoteChange,
  onCreate,
  busy,
}: Props) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} className="top-1/4 w-96 max-w-[92vw]">
      <Dialog.Title className="mb-1 text-sm font-semibold">
        Set up this folder as a vault?
      </Dialog.Title>
      <p className="mb-3 text-xs text-muted-foreground">
        <span className="font-mono">{dir}</span> is not a vault yet. We'll turn on Git tracking for
        it. Files stay plain markdown.
      </p>
      <label className="mb-1 block text-xs text-muted-foreground">
        git remote (optional — you can add one later in settings)
      </label>
      <input
        value={remote}
        onChange={(e) => onRemoteChange(e.target.value)}
        placeholder="https://github.com/you/notes.git"
        className="mb-4 w-full rounded-md border border-input bg-muted px-2 py-1.5 text-sm outline-none focus:border-primary/60"
      />
      <div className="flex justify-end gap-2">
        <Dialog.Close className="rounded-md px-2.5 py-1 text-xs hover:bg-accent">
          Cancel
        </Dialog.Close>
        <button
          onClick={onCreate}
          disabled={busy}
          className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          Create vault
        </button>
      </div>
    </Modal>
  );
}

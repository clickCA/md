import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Download, FolderPlus } from "lucide-react";
import Modal from "../ui/Modal";
import { remoteName } from "../../lib/vault";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "clone";
  busy: boolean;
  onCreate: (name: string, remote: string) => void;
  onClone: (url: string, name: string) => void;
}

/** Mobile-only vault manager entry: create a fresh vault or clone one from a
    git URL into app-sandboxed storage (there is no folder picker on mobile).
    The parent remounts this dialog (via `key`) every time it opens so the form
    always starts fresh. */
export default function AddVaultDialog({
  open,
  onOpenChange,
  mode,
  busy,
  onCreate,
  onClone,
}: Props) {
  const [tab, setTab] = useState(mode);
  const [name, setName] = useState("");
  const [remote, setRemote] = useState("");
  const [url, setUrl] = useState("");

  const derived = remoteName(url);
  const canSubmit = !busy && (tab === "create" ? name.trim().length > 0 : url.trim().length > 0);

  const submit = () => {
    if (!canSubmit) return;
    if (tab === "create") onCreate(name.trim(), remote.trim());
    else onClone(url.trim(), name.trim()); // empty name → backend derives from URL
  };

  const tabBtn = (which: "create" | "clone", label: string) => (
    <button
      type="button"
      onClick={() => setTab(which)}
      className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium ${
        tab === which
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-accent"
      }`}
    >
      {label}
    </button>
  );

  return (
    <Modal open={open} onOpenChange={onOpenChange} className="top-1/4 w-96 max-w-[92vw]">
      <Dialog.Title className="mb-3 text-sm font-semibold">Add vault</Dialog.Title>

      <div className="mb-4 flex gap-1 rounded-md border border-border bg-muted/50 p-1">
        {tabBtn("create", "Create")}
        {tabBtn("clone", "Clone from URL")}
      </div>

      {tab === "create" ? (
        <>
          <label className="mb-1 block text-xs text-muted-foreground">vault name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My notes"
            className="mb-3 w-full rounded-md border border-input bg-muted px-2 py-1.5 text-sm outline-none focus:border-primary/60"
          />
          <label className="mb-1 block text-xs text-muted-foreground">
            git remote (optional — add one later in settings)
          </label>
          <input
            value={remote}
            onChange={(e) => setRemote(e.target.value)}
            placeholder="https://github.com/you/notes.git"
            className="mb-1 w-full rounded-md border border-input bg-muted px-2 py-1.5 text-sm outline-none focus:border-primary/60"
          />
        </>
      ) : (
        <>
          <label className="mb-1 block text-xs text-muted-foreground">git URL</label>
          <input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/you/notes.git"
            className="mb-3 w-full rounded-md border border-input bg-muted px-2 py-1.5 text-sm outline-none focus:border-primary/60"
          />
          <label className="mb-1 block text-xs text-muted-foreground">vault name (optional)</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={derived || "owner-repo"}
            className="mb-1 w-full rounded-md border border-input bg-muted px-2 py-1.5 text-sm outline-none focus:border-primary/60"
          />
        </>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Dialog.Close className="rounded-md px-2.5 py-1 text-xs hover:bg-accent">
          Cancel
        </Dialog.Close>
        <button
          onClick={submit}
          disabled={!canSubmit}
          className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          {tab === "create" ? (
            <>
              <FolderPlus className="size-3.5" aria-hidden /> Create vault
            </>
          ) : (
            <>
              <Download className="size-3.5" aria-hidden /> Clone vault
            </>
          )}
        </button>
      </div>
    </Modal>
  );
}

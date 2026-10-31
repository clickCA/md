import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { KeyRound } from "lucide-react";
import Modal from "../ui/Modal";
import type { Creds } from "../../types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSignIn: (creds: Creds) => void;
}

export default function CredentialsDialog({ open, onOpenChange, onSignIn }: Props) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");

  const submit = () => {
    if (!user || !pass) return;
    onSignIn({ username: user, password: pass });
    onOpenChange(false);
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} className="top-1/4 w-96 max-w-[92vw]">
      <Dialog.Title className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
        <KeyRound size={14} /> Sign in to sync
      </Dialog.Title>
      <p className="mb-3 text-xs text-muted-foreground">
        The remote needs credentials. For GitHub, use your username and a fine-grained personal
        access token with repository read/write access.
      </p>
      <label className="mb-1 block text-xs text-muted-foreground">username</label>
      <input
        autoFocus
        value={user}
        onChange={(e) => setUser(e.target.value)}
        className="mb-3 w-full rounded-md border border-input bg-muted px-2 py-1.5 text-sm outline-none focus:border-primary/60"
      />
      <label className="mb-1 block text-xs text-muted-foreground">password / token</label>
      <input
        type="password"
        value={pass}
        onChange={(e) => setPass(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        className="mb-4 w-full rounded-md border border-input bg-muted px-2 py-1.5 text-sm outline-none focus:border-primary/60"
      />
      <div className="flex justify-end gap-2">
        <Dialog.Close className="rounded-md px-2.5 py-1 text-xs hover:bg-accent">
          Cancel
        </Dialog.Close>
        <button
          onClick={submit}
          disabled={!user || !pass}
          className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          Sign in &amp; sync
        </button>
      </div>
    </Modal>
  );
}

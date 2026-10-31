import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Probe } from "./types";
import { DEFAULT_DIR, resolveDefaultDir } from "./lib/vault";
import { useVault } from "./hooks/useVault";
import { Workspace } from "./components/quire/workspace";
import ConflictCard from "./components/ConflictCard";
import CredentialsDialog from "./components/dialogs/CredentialsDialog";
import VaultSetupDialog from "./components/dialogs/VaultSetupDialog";
import VaultSettingsDialog from "./components/dialogs/VaultSettingsDialog";

export default function App() {
  const [dir, setDir] = useState(DEFAULT_DIR);
  const [isLight, setIsLight] = useState(
    () => !(window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [remote, setRemote] = useState("");
  const [setupDir, setSetupDir] = useState<string | null>(null);

  const vault = useVault(dir);
  const { status, busy, error, run, refresh } = vault;

  useEffect(() => {
    void resolveDefaultDir().then(setDir);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("light", isLight);
  }, [isLight]);

  useEffect(() => {
    if (settingsOpen) setRemote(vault.gitState?.remoteUrl ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen]);

  /** Native folder picker → probe → open, or offer one-step vault setup. */
  const pickVault = async () => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Choose vault folder",
    });
    if (typeof picked !== "string" || !picked) return;
    const probe = await invoke<Probe>("vault_probe", { dir: picked });
    if (probe.isVault) {
      setDir(picked);
    } else {
      setRemote(probe.remoteUrl ?? "");
      setSetupDir(picked);
    }
  };

  const connectVault = (d: string, remoteUrl: string | null) =>
    run("connect", async () => {
      await invoke("vault_make", { dir: d, remoteUrl });
      await refresh(d);
      setSetupDir(null);
    });

  return (
    <div className="flex h-dvh flex-col">
      {error && (
        <div className="bg-destructive/10 px-4 py-1.5 text-xs text-destructive">{error}</div>
      )}

      {status && status.conflicts.length > 0 && (
        <ConflictCard
          dir={dir}
          conflicts={status.conflicts}
          busy={busy}
          onResolved={() => void vault.refresh()}
        />
      )}

      <div className="flex min-h-0 flex-1">
        <Workspace
          vault={vault}
          dark={!isLight}
          onToggleTheme={() => setIsLight((v) => !v)}
          onOpenFolder={() => void pickVault()}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </div>

      <VaultSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        dir={dir}
        remote={remote}
        onRemoteChange={setRemote}
        onChooseFolder={() => {
          setSettingsOpen(false);
          void pickVault();
        }}
        onSave={() => {
          void connectVault(dir, remote.trim() ? remote.trim() : null);
          setSettingsOpen(false);
        }}
        busy={busy}
        autoSync={vault.autoSync}
        onAutoSyncChange={vault.setAutoSync}
      />

      <VaultSetupDialog
        open={setupDir !== null}
        onOpenChange={(o) => !o && setSetupDir(null)}
        dir={setupDir ?? ""}
        remote={remote}
        onRemoteChange={setRemote}
        onCreate={() => void connectVault(setupDir!, remote.trim() || null)}
        busy={busy}
      />

      <CredentialsDialog
        open={vault.authOpen}
        onOpenChange={vault.setAuthOpen}
        onSignIn={vault.onSignIn}
      />
    </div>
  );
}

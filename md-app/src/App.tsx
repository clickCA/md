import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileText } from "lucide-react";
import type { Probe } from "./types";
import { DEFAULT_DIR, resolveDefaultDir } from "./lib/vault";
import { useVault } from "./hooks/useVault";
import { useTypography } from "./hooks/useTypography";
import { Workspace } from "./components/quire/workspace";
import { Welcome } from "./components/Welcome";
import ConflictCard from "./components/ConflictCard";
import ClipboardMenu from "./components/ui/ClipboardMenu";
import CredentialsDialog from "./components/dialogs/CredentialsDialog";
import TypographySettingsDialog from "./components/dialogs/TypographySettingsDialog";
import VaultSetupDialog from "./components/dialogs/VaultSetupDialog";
import VaultSettingsDialog from "./components/dialogs/VaultSettingsDialog";

/** Boot probes the default folder: not a vault yet → landing screen. */
type Phase = "probing" | "landing" | "vault";

export default function App() {
  const [dir, setDir] = useState(DEFAULT_DIR);
  const [phase, setPhase] = useState<Phase>("probing");
  const [isLight, setIsLight] = useState(
    () => !(window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [typographyOpen, setTypographyOpen] = useState(false);
  const [remote, setRemote] = useState("");
  const [setupDir, setSetupDir] = useState<string | null>(null);
  const [typography, setTypography] = useTypography();

  const vault = useVault(dir);
  const { status, busy, error, run, refresh } = vault;

  useEffect(() => {
    void resolveDefaultDir().then(async (d) => {
      setDir(d);
      try {
        const probe = await invoke<Probe>("vault_probe", { dir: d });
        setPhase(probe.isVault ? "vault" : "landing");
      } catch {
        setPhase("landing");
      }
    });
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
      setPhase("vault");
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
      // Point the vault hook at the created folder — required when d differs
      // from the current dir (setup dialog), a no-op bail-out on the landing
      // path (d === dir, already refreshed above).
      setDir(d);
      setPhase("vault");
    });

  if (phase === "probing") {
    return (
      <div className="grid h-dvh place-items-center">
        <span className="grid size-9 place-items-center rounded-md bg-primary text-primary-foreground">
          <FileText className="size-5" aria-hidden />
        </span>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      {phase === "vault" && error && (
        <div className="bg-destructive/10 px-4 py-1.5 text-xs text-destructive">{error}</div>
      )}

      {phase === "vault" && status && status.conflicts.length > 0 && (
        <ConflictCard
          dir={dir}
          conflicts={status.conflicts}
          busy={busy}
          onResolved={() => void vault.refresh()}
        />
      )}

      {phase === "vault" ? (
        <div className="flex min-h-0 flex-1">
          <Workspace
            vault={vault}
            dark={!isLight}
            onToggleTheme={() => setIsLight((v) => !v)}
            onOpenFolder={() => void pickVault()}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenTypography={() => setTypographyOpen(true)}
          />
        </div>
      ) : (
        <Welcome
          busy={busy}
          dark={!isLight}
          defaultDir={dir}
          onToggleTheme={() => setIsLight((v) => !v)}
          onOpenFolder={() => void pickVault()}
          onCreateVault={() => void connectVault(dir, null)}
        />
      )}

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

      <TypographySettingsDialog
        open={typographyOpen}
        onOpenChange={setTypographyOpen}
        settings={typography}
        onChange={setTypography}
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

      {/* Cross-platform Cut/Copy/Paste right-click menu (also owns the
          blanket suppression of the engine's default context menu). */}
      <ClipboardMenu />
    </div>
  );
}

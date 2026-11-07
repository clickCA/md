import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileText } from "lucide-react";
import type { Creds, Probe, VaultInfo } from "./types";
import { DEFAULT_DIR, resolveDefaultDir, sanitizeVaultName } from "./lib/vault";
import { isAuthError } from "./lib/ipc";
import { isMobile, persistLastVault, readLastVault } from "./lib/platform";
import { useVault } from "./hooks/useVault";
import { useTypography } from "./hooks/useTypography";
import { useUpdate } from "./hooks/useUpdate";
import { Workspace } from "./components/quire/Workspace";
import { UpdateBanner } from "./components/quire/UpdateBanner";
import { Welcome } from "./components/Welcome";
import ConflictCard from "./components/ConflictCard";
import ClipboardMenu from "./components/ui/ClipboardMenu";
import AddVaultDialog from "./components/dialogs/AddVaultDialog";
import CredentialsDialog from "./components/dialogs/CredentialsDialog";
import TypographySettingsDialog from "./components/dialogs/TypographySettingsDialog";
import VaultSetupDialog from "./components/dialogs/VaultSetupDialog";
import VaultSettingsDialog from "./components/dialogs/VaultSettingsDialog";
import VaultsDialog from "./components/dialogs/VaultsDialog";

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

  // Mobile vault manager state (app-sandboxed vaults — no folder picker).
  const [vaultsHome, setVaultsHome] = useState("");
  const [vaultList, setVaultList] = useState<VaultInfo[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<"create" | "clone">("create");
  // Forces AddVaultDialog to remount (fresh form) each time it opens.
  const [addSeq, setAddSeq] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  const [clonePending, setClonePending] = useState<{ url: string; name: string } | null>(null);
  const [cloneAuthOpen, setCloneAuthOpen] = useState(false);

  const openAdd = (mode: "create" | "clone") => {
    setAddMode(mode);
    setAddSeq((s) => s + 1);
    setAddOpen(true);
  };

  const vault = useVault(dir);
  const { status, busy, error, run, refresh } = vault;
  const updater = useUpdate();

  useEffect(() => {
    void (async () => {
      let d = DEFAULT_DIR;
      try {
        d = await resolveDefaultDir();
      } catch {
        /* keep the fallback */
      }

      if (isMobile) {
        // Vault manager lives in app-sandboxed storage: load it and reopen the
        // last-active vault when there is one.
        try {
          const home = await invoke<string>("vaults_home");
          setVaultsHome(home);
          setVaultList(await invoke<VaultInfo[]>("vault_list").catch(() => []));
        } catch {
          /* vault manager unavailable — fall through to landing */
        }
        const last = readLastVault();
        if (last) {
          try {
            const probe = await invoke<Probe>("vault_probe", { dir: last });
            if (probe.isVault) {
              setDir(last);
              setPhase("vault");
              return;
            }
          } catch {
            /* stale entry — re-probe the default dir below */
          }
        }
      }

      setDir(d);
      try {
        const probe = await invoke<Probe>("vault_probe", { dir: d });
        setPhase(probe.isVault ? "vault" : "landing");
      } catch {
        setPhase("landing");
      }
    })();
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

  /** Enter the vault phase at `d`, remembering it on mobile so boot reopens it. */
  const adoptVault = (d: string) => {
    persistLastVault(d);
    setDir(d);
    setPhase("vault");
  };

  const connectVault = (d: string, remoteUrl: string | null) =>
    run("connect", async () => {
      await invoke("vault_make", { dir: d, remoteUrl });
      await refresh(d);
      setSetupDir(null);
      // Point the vault hook at the created folder — required when d differs
      // from the current dir (setup dialog), a no-op bail-out on the landing
      // path (d === dir, already refreshed above).
      adoptVault(d);
    });

  const reloadVaults = async () => {
    if (!isMobile) return;
    try {
      setVaultList(await invoke<VaultInfo[]>("vault_list"));
    } catch {
      /* non-fatal: stale list shows next boot */
    }
  };

  /** Mobile: create a fresh vault under the sandboxed vaults home. */
  const createMobile = (name: string, remoteUrl: string) =>
    run("create", async () => {
      if (!vaultsHome) throw new Error("vault storage is unavailable");
      const dir = `${vaultsHome}/${sanitizeVaultName(name)}`;
      await invoke("vault_make", { dir, remoteUrl: remoteUrl.trim() ? remoteUrl.trim() : null });
      await refresh(dir);
      setAddOpen(false);
      adoptVault(dir);
      void reloadVaults();
    });

  /** One clone attempt; auth failures open the credentials dialog instead of surfacing. */
  const doClone = async (url: string, name: string, credentials: Creds | null): Promise<void> => {
    try {
      const info = await invoke<VaultInfo>("vault_clone", {
        url,
        name: name.trim() || null,
        credentials,
      });
      adoptVault(info.dir);
      void reloadVaults();
    } catch (e) {
      if (isAuthError(e)) {
        setClonePending({ url, name });
        setCloneAuthOpen(true);
        return;
      }
      throw e;
    }
  };

  /** Mobile: clone from a git URL, prompting for credentials on auth failure. */
  const handleClone = (url: string, name: string) => {
    setAddOpen(false);
    void run("clone", async () => doClone(url, name, null));
  };

  const onCloneSignIn = (credentials: Creds) => {
    setCloneAuthOpen(false);
    const pending = clonePending;
    setClonePending(null);
    if (!pending) return;
    void run("clone", async () => doClone(pending.url, pending.name, credentials));
  };

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
            onCheckUpdates={() => void updater.checkNow()}
            onToggleTheme={() => setIsLight((v) => !v)}
            onOpenFolder={() => (isMobile ? setListOpen(true) : void pickVault())}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenTypography={() => setTypographyOpen(true)}
          />
        </div>
      ) : (
        <Welcome
          busy={busy}
          dark={!isLight}
          isMobile={isMobile}
          defaultDir={dir}
          vaultsHome={vaultsHome}
          vaultCount={vaultList.length}
          onToggleTheme={() => setIsLight((v) => !v)}
          onOpenFolder={() => void pickVault()}
          onCreateVault={() => void connectVault(dir, null)}
          onCreateRequested={() => openAdd("create")}
          onCloneRequested={() => openAdd("clone")}
          onListVaults={() => setListOpen(true)}
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

      {/* Mobile-only: create/clone vault manager + vault picker (no folder dialog). */}
      {isMobile && (
        <>
          <AddVaultDialog
            key={`add-${addMode}-${addSeq}`}
            open={addOpen}
            onOpenChange={setAddOpen}
            mode={addMode}
            busy={busy}
            onCreate={createMobile}
            onClone={handleClone}
          />
          <VaultsDialog
            open={listOpen}
            onOpenChange={setListOpen}
            vaults={vaultList}
            busy={busy}
            onOpen={(d) => {
              setListOpen(false);
              adoptVault(d);
            }}
            onAdd={() => {
              setListOpen(false);
              openAdd("create");
            }}
          />
          <CredentialsDialog
            open={cloneAuthOpen}
            onOpenChange={setCloneAuthOpen}
            onSignIn={onCloneSignIn}
            purpose="clone"
          />
        </>
      )}

      {/* Cross-platform Cut/Copy/Paste right-click menu (also owns the
          blanket suppression of the engine's default context menu). */}
      <ClipboardMenu />

      {/* Auto-update (updater plugin): appears only when a newer signed
          release exists and the transport is reachable. */}
      <UpdateBanner
        update={updater.update}
        installing={updater.installing}
        error={updater.error}
        onInstall={() => void updater.install()}
        onDismiss={updater.dismiss}
      />
    </div>
  );
}

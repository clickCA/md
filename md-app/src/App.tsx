import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Conflict {
  path: string;
  conflictCopy: string;
  winner: string;
  at: string;
}

interface Journal {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  events: [string, string][];
}

interface Status {
  root: string;
  head: string | null;
  remoteMain: string | null;
  pending: boolean;
  conflicts: Conflict[];
  lastRun: Journal | null;
}

interface SyncResult {
  action: string;
  head: string | null;
  remote: string | null;
  conflicts: Conflict[];
}

const DEFAULT_DIR = "/tmp/md-vault";
const DEFAULT_REMOTE = "/tmp/md-remote.git";

function short(oid: string | null): string {
  return oid ? oid.slice(0, 8) : "(none)";
}

export default function App() {
  const [dir, setDir] = useState(DEFAULT_DIR);
  const [remoteUrl, setRemoteUrl] = useState(DEFAULT_REMOTE);
  const [status, setStatus] = useState<Status | null>(null);
  const [notePath, setNotePath] = useState("note.md");
  const [noteBody, setNoteBody] = useState("");
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function guard<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(`${label}: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function refresh(d: string) {
    const s = await invoke<Status>("vault_status", { dir: d });
    setStatus(s);
    setSyncResult(null);
  }

  const openVault = () =>
    guard("open", async () => {
      await refresh(dir);
    });

  const initVault = () =>
    guard("init", async () => {
      await invoke<Status>("vault_init", { dir, remoteUrl });
      await refresh(dir);
    });

  const doSync = () =>
    guard("sync", async () => {
      const r = await invoke<SyncResult>("vault_sync", { dir });
      setSyncResult(r);
      await refresh(dir);
    });

  const loadNote = () =>
    guard("read", async () => {
      const body = await invoke<string>("note_read", { dir, path: notePath });
      setNoteBody(body);
    });

  const saveNote = () =>
    guard("write", async () => {
      await invoke("note_write", { dir, path: notePath, content: noteBody });
      await refresh(dir);
    });

  return (
    <main style={{ fontFamily: "sans-serif", padding: 20, maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20 }}>md vault</h1>

      <section style={{ display: "grid", gap: 6, gridTemplateColumns: "auto 1fr" }}>
        <label>vault dir</label>
        <input value={dir} onChange={(e) => setDir(e.target.value)} />
        <label>remote</label>
        <input value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} />
      </section>

      <div style={{ margin: "10px 0", display: "flex", gap: 8 }}>
        <button onClick={openVault} disabled={busy}>Open</button>
        <button onClick={initVault} disabled={busy}>Init w/ remote</button>
        <button onClick={doSync} disabled={busy || !status}>Sync</button>
      </div>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {status && (
        <>
          <section style={{ background: "#f4f4f4", padding: 12, borderRadius: 8, fontSize: 14 }}>
            <div><b>head:</b> {short(status.head)} {status.pending && <span style={{ color: "darkorange" }}>(pending changes)</span>}</div>
            <div><b>remote:</b> {short(status.remoteMain)}</div>
            {status.lastRun && (
              <div>
                <b>last run:</b> #{status.lastRun.id} {status.lastRun.outcome ?? "(unfinished)"}
                {status.lastRun.events.length > 0 && (
                  <span> [{status.lastRun.events.map((e) => e[1]).join(" → ")}]</span>
                )}
              </div>
            )}
            {status.conflicts.length > 0 && (
              <ul style={{ color: "crimson" }}>
                {status.conflicts.map((c) => (
                  <li key={c.conflictCopy}>
                    {c.path} → {c.conflictCopy} (winner: {c.winner})
                  </li>
                ))}
              </ul>
            )}
          </section>

          <h2 style={{ fontSize: 16 }}>note</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={notePath} onChange={(e) => setNotePath(e.target.value)} />
            <button onClick={loadNote} disabled={busy}>Load</button>
          </div>
          <textarea
            value={noteBody}
            onChange={(e) => setNoteBody(e.target.value)}
            rows={12}
            style={{ width: "100%", marginTop: 8, fontFamily: "monospace" }}
          />
          <button onClick={saveNote} disabled={busy}>Save note</button>

          {syncResult && (
            <p>
              <b>sync:</b> {syncResult.action} → {short(syncResult.head)}{" "}
              {syncResult.conflicts.length > 0 && `(${syncResult.conflicts.length} conflicts)`}
            </p>
          )}
        </>
      )}
    </main>
  );
}

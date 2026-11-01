import {
  Check,
  FileText,
  FolderOpen,
  FolderPlus,
  GitBranch,
  MonitorSmartphone,
  Moon,
  Search,
  Sun,
} from "lucide-react";

type Props = {
  busy: boolean;
  dark: boolean;
  /** Resolved default vault location, shown as the one-click target. */
  defaultDir: string;
  onToggleTheme: () => void;
  onOpenFolder: () => void;
  onCreateVault: () => void;
};

const features = [
  {
    icon: FileText,
    title: "Plain markdown",
    body: "Every note is a .md file on disk. No lock-in, no database — your vault opens in any editor, forever.",
  },
  {
    icon: GitBranch,
    title: "Git-backed sync",
    body: "Every sync is a commit on a standard git remote you own. Non-overlapping edits auto-merge line by line.",
  },
  {
    icon: Check,
    title: "Nothing gets lost",
    body: "Conflicts never overwrite: the loser is preserved as a sibling note and resolved in the app, edit beats delete.",
  },
  {
    icon: Search,
    title: "Instant search",
    body: "A per-vault SQLite FTS5 index, stat-verified before every query — external edits are always visible.",
  },
];

/** Fake note window for the hero — reuses the app's real syntax tokens so the
    mock looks exactly like the editor it advertises, in both themes. */
function HeroNote() {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-2xl shadow-black/50">
      <div className="flex items-center gap-1.5 border-b border-border bg-panel px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-border" aria-hidden />
        <span className="size-2.5 rounded-full bg-border" aria-hidden />
        <span className="size-2.5 rounded-full bg-border" aria-hidden />
        <span className="ml-3 font-mono text-xs text-muted-foreground">sync-engine.md</span>
        <span className="ml-auto flex items-center gap-1 rounded-sm bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">
          <Check className="size-3" aria-hidden />
          synced
        </span>
      </div>
      <div className="space-y-2.5 p-5 font-mono text-[13px] leading-6">
        <p>
          <span className="text-muted-foreground"># </span>
          <span className="font-semibold" style={{ color: "var(--heading)" }}>
            Sync engine
          </span>
        </p>
        <p>
          <span className="text-primary">- </span>
          notes are <span style={{ color: "var(--hl-str)" }}>"plain .md files"</span> on disk
        </p>
        <p>
          <span className="text-primary">- </span>
          every sync is journaled and <span style={{ color: "var(--hl-kw)" }}>idempotent</span>
        </p>
        <p>
          <span className="text-primary">- </span>
          merges are <code className="rounded-sm bg-muted px-1.5 py-0.5">diff3</code> at the line
          level
        </p>
        <p className="border-l-2 border-border pl-3 italic text-muted-foreground">
          a kill at any state still converges
        </p>
      </div>
    </div>
  );
}

export function Landing({
  busy,
  dark,
  defaultDir,
  onToggleTheme,
  onOpenFolder,
  onCreateVault,
}: Props) {
  return (
    <div className="h-dvh overflow-y-auto bg-[radial-gradient(60%_50%_at_50%_0%,oklch(0.84_0.17_95/0.07),transparent)]">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-6">
        {/* top bar */}
        <header className="flex items-center justify-between py-5">
          <div className="flex items-center gap-2.5">
            <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
              <FileText className="size-4" aria-hidden />
            </span>
            <span className="font-mono text-sm font-bold tracking-tight text-heading">md</span>
          </div>
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            {dark ? (
              <Sun className="size-4" aria-hidden />
            ) : (
              <Moon className="size-4" aria-hidden />
            )}
          </button>
        </header>

        {/* hero */}
        <section className="grid flex-1 items-center gap-12 py-12 lg:grid-cols-[1.05fr_1fr] lg:py-16">
          <div>
            <p className="mb-4 inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 font-mono text-[11px] text-primary">
              <MonitorSmartphone className="size-3.5" aria-hidden />
              local-first · git-backed
            </p>
            <h1 className="text-4xl font-bold tracking-tight text-balance text-heading sm:text-5xl">
              Plain markdown.
              <br />
              <span className="text-primary">Serious sync.</span>
            </h1>
            <p className="mt-4 max-w-md text-pretty text-[15px] leading-relaxed text-muted-foreground">
              A personal vault where your notes are just files — with a Rust sync engine underneath.
              Every edit committed, every sync journaled, every conflict preserved. Your notes
              outlive the app.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={onCreateVault}
                disabled={busy}
                className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
              >
                <FolderPlus className="size-4" aria-hidden />
                Create new vault
              </button>
              <button
                type="button"
                onClick={onOpenFolder}
                disabled={busy}
                className="flex items-center gap-2 rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-40"
              >
                <FolderOpen className="size-4" aria-hidden />
                Open folder…
              </button>
            </div>
            <p className="mt-4 font-mono text-xs text-muted-foreground">
              first vault lands in <span className="text-foreground/80">{defaultDir}</span> — or
              pick any folder
            </p>
          </div>
          <HeroNote />
        </section>

        {/* features */}
        <section className="grid gap-4 pb-14 sm:grid-cols-2 lg:grid-cols-4">
          {features.map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-lg border border-border bg-card p-5">
              <span className="mb-3 grid size-8 place-items-center rounded-md bg-primary/10 text-primary">
                <Icon className="size-4" aria-hidden />
              </span>
              <h3 className="mb-1 text-sm font-semibold text-heading">{title}</h3>
              <p className="text-[13px] leading-relaxed text-muted-foreground">{body}</p>
            </div>
          ))}
        </section>

        {/* footer */}
        <footer className="flex items-center justify-between border-t border-border py-4 font-mono text-[11px] text-muted-foreground">
          <span>md — personal markdown vault</span>
          <span>tauri 2 · rust core · standard git remotes</span>
        </footer>
      </div>
    </div>
  );
}

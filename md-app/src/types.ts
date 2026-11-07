export interface Conflict {
  path: string;
  conflictCopy: string;
  winner: string;
  at: string;
}

export interface Journal {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  events: [string, string][];
}

export interface Status {
  root: string;
  head: string | null;
  remoteMain: string | null;
  pending: boolean;
  conflicts: Conflict[];
  lastRun: Journal | null;
}

export interface SyncResult {
  action: string;
  head: string | null;
  remote: string | null;
  conflicts: Conflict[];
}

export interface Creds {
  username: string;
  password: string;
}

export interface GitState {
  remoteUrl: string | null;
  /** Branch HEAD points at; commits and pushes follow it. */
  branch: string;
  head: string | null;
  remote: string | null;
  relation: string;
}

/** Local branches of the vault (for the branch picker). */
export interface Branches {
  current: string;
  branches: string[];
}

export interface Probe {
  exists: boolean;
  isVault: boolean;
  remoteUrl: string | null;
  noteCount: number | null;
}

/** A managed vault inside the app-sandboxed vaults home (mobile). */
export interface VaultInfo {
  name: string;
  dir: string;
  remoteUrl: string | null;
  noteCount: number | null;
}

/** One entry of a note's history (path-aware, rename-following). */
export interface HistoryEntry {
  oid: string;
  message: string;
  author: string;
  /** Commit time, seconds since the Unix epoch. */
  time: number;
  /** How the revision changed the note. */
  change: "added" | "modified" | "deleted";
  /** Path the note had at this revision (differs after a rename). */
  path: string;
}

/** A commit in the vault-wide history. */
export interface CommitInfo {
  oid: string;
  message: string;
  author: string;
  time: number;
}

/** One unresolved internal link from the broken-links report. */
export interface BrokenLink {
  /** Note containing the reference. */
  source: string;
  /** Link target as written (dialect included: alias/fragment raw). */
  target: string;
  /** 1-based line of the reference in the source note. */
  line: number;
  /** "wiki" | "markdown". */
  kind: string;
  /** Original link text (alias side for wikilinks, label for markdown). */
  text: string;
}

/** One configured remote and how the current branch relates to it. */
export interface RemoteState {
  name: string;
  url: string;
  /** The push target — plain sync fetches from and pushes here. */
  primary: boolean;
  /** in-sync | ahead | behind | diverged | unrelated | empty |
      not-published | remote-only */
  relation: string;
}

export interface Remotes {
  primary: string;
  remotes: RemoteState[];
}

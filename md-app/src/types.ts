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
  head: string | null;
  remote: string | null;
  relation: string;
}

export interface Probe {
  exists: boolean;
  isVault: boolean;
  remoteUrl: string | null;
  noteCount: number | null;
}

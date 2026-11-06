use anyhow::Result;
use std::collections::BTreeMap;
use std::path::Path;

pub type Oid = String;

#[derive(Debug, Clone)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

#[derive(Debug)]
pub struct AuthRequired;

impl std::fmt::Display for AuthRequired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "authentication required")
    }
}

impl std::error::Error for AuthRequired {}

pub struct TreeEntry {
    pub oid: Oid,
    pub is_dir: bool,
}

/// Commit metadata for history views: who, when, what the sync wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitMeta {
    pub oid: Oid,
    pub message: String,
    pub author: String,
    /// Commit time, seconds since the Unix epoch.
    pub time: i64,
}

pub type Tree = BTreeMap<String, TreeEntry>;

pub trait GitBackend {
    fn init(path: &Path) -> Result<Self>
    where
        Self: Sized;
    fn init_bare(path: &Path) -> Result<Self>
    where
        Self: Sized;
    fn open(path: &Path) -> Result<Self>
    where
        Self: Sized;
    fn set_remote(&mut self, url: &str) -> Result<()>;
    fn remote_url(&self) -> Result<Option<String>>;
    /// Branch HEAD points at ("main" until/unless switched; detached HEAD
    /// reads as "main" — the vault model never detaches).
    fn current_branch(&self) -> Result<String>;
    /// Local branch names (refs/heads/*), sorted.
    fn list_branches(&self) -> Result<Vec<String>>;
    /// Tip of a local branch, if it exists.
    fn branch_oid(&self, branch: &str) -> Result<Option<Oid>>;
    /// Create `branch` at `at` (default: the current head). Never switches.
    fn create_branch(&self, branch: &str, at: Option<&Oid>) -> Result<()>;
    /// Point HEAD at `branch` (the switch itself; file checkout is the
    /// engine's job — it must refuse when the working tree is dirty).
    fn set_head_branch(&self, branch: &str) -> Result<()>;
    /// Remote tip of `branch` (origin/<branch>).
    fn remote_branch_oid(&self, branch: &str) -> Result<Option<Oid>>;
    fn head_oid(&self) -> Result<Option<Oid>>;
    fn fetch(&self, creds: Option<&Credentials>) -> Result<Option<Oid>>;
    /// Publish the current branch to origin (same branch name).
    fn push_current(&self, expected_local: &Oid, creds: Option<&Credentials>) -> Result<()>;
    /// Overwrite origin's current branch with the local tip.
    fn force_push_current(&self, expected_local: &Oid, creds: Option<&Credentials>) -> Result<()>;
    fn merge_base(&self, a: &Oid, b: &Oid) -> Result<Option<Oid>>;
    fn commit_tree_of(&self, commit: &Oid) -> Result<Oid>;
    fn commit_time(&self, commit: &Oid) -> Result<i64>;
    /// Message, author name, and time of a commit (history views).
    fn commit_info(&self, commit: &Oid) -> Result<CommitMeta>;
    fn tree_of(&self, tree_oid: &Oid) -> Result<Tree>;
    fn read_blob(&self, oid: &Oid) -> Result<Vec<u8>>;
    fn write_blob(&self, data: &[u8]) -> Result<Oid>;
    fn read_commit_parents(&self, commit: &Oid) -> Result<Vec<Oid>>;
    fn create_commit(&self, tree: &Tree, parents: &[Oid], message: &str) -> Result<Oid>;
    /// Move the current branch's ref to `commit` (commit / take-remote).
    fn update_branch(&self, commit: &Oid) -> Result<()>;
    fn head_tree(&self) -> Result<Tree>;
    /// Worktree files eligible for tracking: tracked + untracked, respecting
    /// .gitignore. Excludes vault bookkeeping files (index.db*).
    fn list_worktree_files(&self) -> Result<Vec<String>>;
}

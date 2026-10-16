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

pub type Tree = BTreeMap<String, TreeEntry>;

pub trait GitBackend {
    fn init(path: &Path) -> Result<Self> where Self: Sized;
    fn init_bare(path: &Path) -> Result<Self> where Self: Sized;
    fn open(path: &Path) -> Result<Self> where Self: Sized;
    fn set_remote(&mut self, url: &str) -> Result<()>;
    fn remote_url(&self) -> Result<Option<String>>;
    fn head_oid(&self) -> Result<Option<Oid>>;
    fn remote_main_oid(&self) -> Result<Option<Oid>>;
    fn fetch(&self, creds: Option<&Credentials>) -> Result<Option<Oid>>;
    fn push_main(&self, expected_local: &Oid, creds: Option<&Credentials>) -> Result<()>;
    fn force_push_main(&self, expected_local: &Oid, creds: Option<&Credentials>) -> Result<()>;
    fn merge_base(&self, a: &Oid, b: &Oid) -> Result<Option<Oid>>;
    fn commit_tree_of(&self, commit: &Oid) -> Result<Oid>;
    fn commit_time(&self, commit: &Oid) -> Result<i64>;
    fn tree_of(&self, tree_oid: &Oid) -> Result<Tree>;
    fn read_blob(&self, oid: &Oid) -> Result<Vec<u8>>;
    fn write_blob(&self, data: &[u8]) -> Result<Oid>;
    fn read_commit_parents(&self, commit: &Oid) -> Result<Vec<Oid>>;
    fn create_commit(&self, tree: &Tree, parents: &[Oid], message: &str) -> Result<Oid>;
    fn update_main(&self, commit: &Oid) -> Result<()>;
    fn head_tree(&self) -> Result<Tree>;
    /// Worktree files eligible for tracking: tracked + untracked, respecting
    /// .gitignore. Excludes vault bookkeeping files (index.db*).
    fn list_worktree_files(&self) -> Result<Vec<String>>;
}

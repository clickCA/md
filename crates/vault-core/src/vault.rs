use crate::db::Db;
use crate::git_backend::{GitBackend, Oid, Tree, TreeEntry};
use crate::gix_backend::GixBackend;
use anyhow::{anyhow, Result};
use std::fs;
use std::path::{Path, PathBuf};

pub struct Vault {
    pub root: PathBuf,
    pub git: GixBackend,
    pub db: Db,
}

impl Vault {
    pub fn create_remote(path: &Path) -> Result<()> {
        GixBackend::init_bare(path)?;
        Ok(())
    }

    pub fn create(root: &Path, remote: Option<&str>) -> Result<Self> {
        fs::create_dir_all(root)?;
        let mut git = GixBackend::init(root)?;
        if let Some(url) = remote {
            git.set_remote(url)?;
        }
        let db = Db::open(root)?;
        Ok(Self { root: root.to_path_buf(), git, db })
    }

    pub fn open(root: &Path) -> Result<Self> {
        if !root.join(".git").exists() {
            return Err(anyhow!("not a vault: {}", root.display()));
        }
        let git = GixBackend::open(root)?;
        let db = Db::open(root)?;
        Ok(Self { root: root.to_path_buf(), git, db })
    }

    pub fn write_note(&self, rel: &str, content: &str) -> Result<()> {
        let path = self.root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, content)?;
        Ok(())
    }

    pub fn delete_note(&self, rel: &str) -> Result<()> {
        let path = self.root.join(rel);
        if path.exists() {
            fs::remove_file(&path)?;
        }
        if let Some(parent) = path.parent() {
            if parent != self.root {
                let _ = fs::remove_dir(parent);
            }
        }
        Ok(())
    }

    pub fn fs_files(&self) -> Result<Vec<(String, PathBuf)>> {
        let files = self.git.list_worktree_files()?;
        Ok(files
            .into_iter()
            .map(|rel| {
                let rel2 = rel.clone();
                (rel, self.root.join(rel2))
            })
            .collect())
    }

    pub fn fs_tree(&self) -> Result<Tree> {
        let mut tree = Tree::new();
        for (rel, path) in self.fs_files()? {
            let meta = fs::metadata(&path)?;
            let mtime = meta
                .modified()?
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as i64)
                .unwrap_or(0);
            if let Some((size, mt, oid)) = self.db.cached_blob(&rel) {
                if size == meta.len() as i64 && mt == mtime {
                    tree.insert(rel, TreeEntry { oid, is_dir: false });
                    continue;
                }
            }
            let data = fs::read(&path)?;
            let oid = self.git.write_blob(&data)?;
            let _ = self.db.put_blob_cache(&rel, meta.len() as i64, mtime, &oid);
            tree.insert(rel, TreeEntry { oid, is_dir: false });
        }
        Ok(tree)
    }
}

#[derive(Debug, Clone)]
pub struct SearchMatch {
    pub line: usize,
    pub snippet: String,
}

#[derive(Debug, Clone)]
pub struct SearchHit {
    pub path: String,
    pub matches: Vec<SearchMatch>,
}

impl Vault {
    /// Case-insensitive multi-term search (all terms must appear on a line).
    /// Returns up to `limit` hits, each with up to 5 matching lines.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let terms: Vec<String> = query
            .split_whitespace()
            .map(|t| t.to_lowercase())
            .collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let mut hits = Vec::new();
        for (rel, path) in self.fs_files()? {
            if !rel.ends_with(".md") {
                continue;
            }
            let content = match fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let mut matches = Vec::new();
            for (i, line) in content.lines().enumerate() {
                let lower = line.to_lowercase();
                if terms.iter().all(|t| lower.contains(t)) {
                    let trimmed = line.trim();
                    let snippet = if trimmed.len() > 120 {
                        format!("{}…", &trimmed[..120])
                    } else {
                        trimmed.to_string()
                    };
                    matches.push(SearchMatch { line: i + 1, snippet });
                    if matches.len() >= 5 {
                        break;
                    }
                }
            }
            if !matches.is_empty() {
                hits.push(SearchHit { path: rel, matches });
                if hits.len() >= limit {
                    break;
                }
            }
        }
        Ok(hits)
    }
}

impl Vault {
    pub fn commit_pending(&self, message: &str) -> Result<Option<Oid>> {
        let fs_tree = self.fs_tree()?;
        let head_tree = self.git.head_tree()?;
        let fs_blobs = crate::merge::flatten_blobs(&fs_tree);
        let head_blobs = crate::merge::flatten_blobs(&head_tree);
        if fs_blobs == head_blobs {
            return Ok(None);
        }
        if fs_blobs.len() > 5000 {
            return Err(anyhow!(
                "vault has {} eligible files (limit 5000) — add a .gitignore for build output and dependencies first",
                fs_blobs.len()
            ));
        }
        let parent = self.git.head_oid()?;
        let commit = self.git.create_commit(&fs_tree, &parent.into_iter().collect::<Vec<_>>(), message)?;
        self.git.update_main(&commit)?;
        Ok(Some(commit))
    }

    pub fn materialize(&self, blobs: &std::collections::BTreeMap<String, String>) -> Result<()> {
        let desired: std::collections::BTreeSet<String> = blobs.keys().cloned().collect();
        for (rel, path) in self.fs_files()? {
            if !desired.contains(&rel) {
                fs::remove_file(&path)?;
            }
        }
        for (rel, oid) in blobs {
            let data = self.git.read_blob(oid)?;
            let path = self.root.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            let existing = fs::read(&path).unwrap_or_default();
            if existing != data {
                fs::write(&path, data)?;
            }
        }
        Ok(())
    }
}

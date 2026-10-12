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

fn is_ignored(name: &str) -> bool {
    name == ".git" || name == "index.db" || name.starts_with("index.db-")
}

fn walk(root: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) -> Result<()> {
    let mut entries: Vec<_> = fs::read_dir(root)?.collect::<std::io::Result<_>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored(&name) {
            continue;
        }
        let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        let path = entry.path();
        if path.is_dir() {
            walk(&path, &rel, out)?;
        } else {
            out.push((rel, path));
        }
    }
    Ok(())
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
        let mut out = Vec::new();
        walk(&self.root, "", &mut out)?;
        Ok(out)
    }

    pub fn fs_tree(&self) -> Result<Tree> {
        let mut tree = Tree::new();
        for (rel, path) in self.fs_files()? {
            let data = fs::read(&path)?;
            let oid = self.git.write_blob(&data)?;
            tree.insert(rel, TreeEntry { oid, is_dir: false });
        }
        Ok(tree)
    }

    pub fn commit_pending(&self, message: &str) -> Result<Option<Oid>> {
        let fs_tree = self.fs_tree()?;
        let head_tree = self.git.head_tree()?;
        let fs_blobs = crate::merge::flatten_blobs(&fs_tree);
        let head_blobs = crate::merge::flatten_blobs(&head_tree);
        if fs_blobs == head_blobs {
            return Ok(None);
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

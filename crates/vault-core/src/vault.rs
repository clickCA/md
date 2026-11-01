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
        Ok(Self {
            root: root.to_path_buf(),
            git,
            db,
        })
    }

    pub fn open(root: &Path) -> Result<Self> {
        if !root.join(".git").exists() {
            return Err(anyhow!("not a vault: {}", root.display()));
        }
        let git = GixBackend::open(root)?;
        let db = Db::open(root)?;
        Ok(Self {
            root: root.to_path_buf(),
            git,
            db,
        })
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
    /// Search notes for all terms (AND semantics), most relevant first.
    ///
    /// Backed by an FTS5 index in the per-vault SQLite database. The index is
    /// a rebuildable optimization: before every query the current files are
    /// stat-ed and compared against the indexed signature — any drift (new,
    /// edited, deleted, external) triggers an incremental update of just the
    /// drifted files, so an external editor can never make results stale.
    /// The index is never treated as proof that a note exists.
    ///
    /// Non-ASCII queries (Thai, CJK, …) fall back to the line scan when the
    /// tokenizer finds nothing: space-less scripts tokenize poorly, and
    /// correctness beats speed for the MVP.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let terms: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let files: Vec<(String, PathBuf)> = self
            .fs_files()?
            .into_iter()
            .filter(|(rel, _)| rel.ends_with(".md"))
            .collect();

        // --- freshness check: stat everything, diff against the signature ---
        let mut current: std::collections::BTreeMap<String, (i64, i64)> =
            std::collections::BTreeMap::new();
        for (rel, path) in &files {
            let mtime = mtime_secs(path);
            let size = fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0);
            current.insert(rel.clone(), (mtime, size));
        }
        let indexed: std::collections::BTreeMap<String, (i64, i64)> = self
            .db
            .search_signature()?
            .into_iter()
            .map(|(path, mtime, size)| (path, (mtime, size)))
            .collect();
        let mut changed = Vec::new();
        for (rel, path) in &files {
            let (mtime, size) = current[rel];
            if indexed.get(rel) != Some(&(mtime, size)) {
                let content = fs::read_to_string(path).unwrap_or_default();
                changed.push((rel.clone(), content, mtime, size));
            }
        }
        let removed: Vec<String> = indexed
            .keys()
            .filter(|rel| !current.contains_key(*rel))
            .cloned()
            .collect();
        if !changed.is_empty() || !removed.is_empty() {
            self.db.search_update(&changed, &removed)?;
        }

        // --- ranked FTS query, then per-note line extraction ---
        if let Some(fts_query) = build_fts_query(&terms) {
            let non_ascii = terms.iter().any(|t| !t.is_ascii());
            match self.db.search_query(&fts_query, limit) {
                Ok(rows) if !rows.is_empty() || !non_ascii => {
                    let mut hits = Vec::new();
                    for (path, _) in rows {
                        let content = match fs::read_to_string(self.root.join(&path)) {
                            Ok(c) => c,
                            Err(_) => continue, // deleted between index and query
                        };
                        let matches = matching_lines(&content, &terms);
                        if matches.is_empty() {
                            continue;
                        }
                        hits.push(SearchHit { path, matches });
                        if hits.len() >= limit {
                            break;
                        }
                    }
                    return Ok(hits);
                }
                Ok(_) => {}  // empty + non-ASCII terms → scan fallback below
                Err(_) => {} // malformed/corrupt index → scan fallback below
            }
        }

        self.search_scan(&files, &terms, limit)
    }

    /// Original line-scan search — always correct, O(all notes). Used as the
    /// fallback for non-ASCII queries and when the index cannot answer.
    fn search_scan(
        &self,
        files: &[(String, PathBuf)],
        terms: &[String],
        limit: usize,
    ) -> Result<Vec<SearchHit>> {
        let mut hits = Vec::new();
        for (rel, path) in files {
            let content = match fs::read_to_string(path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let matches = matching_lines(&content, terms);
            if !matches.is_empty() {
                hits.push(SearchHit {
                    path: rel.clone(),
                    matches,
                });
                if hits.len() >= limit {
                    break;
                }
            }
        }
        Ok(hits)
    }
}

/// Quote each term for FTS5 MATCH. Internal double quotes are stripped;
/// terms that end up empty are dropped; `None` when nothing remains.
fn build_fts_query(terms: &[String]) -> Option<String> {
    let mut parts = Vec::new();
    for t in terms {
        let cleaned: String = t
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '_' || !c.is_ascii())
            .collect();
        let cleaned = cleaned.trim().to_string();
        if cleaned.is_empty() {
            continue;
        }
        parts.push(format!("\"{cleaned}\""));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" AND "))
    }
}

/// Up to 5 lines (1-based) containing every term, with 120-char snippets.
fn matching_lines(content: &str, terms: &[String]) -> Vec<SearchMatch> {
    let mut matches = Vec::new();
    for (i, line) in content.lines().enumerate() {
        let lower = line.to_lowercase();
        if terms.iter().all(|t| lower.contains(t.as_str())) {
            let trimmed = line.trim();
            // char-safe truncation: byte slicing would panic mid-UTF-8 (Thai, CJK…)
            let snippet = if trimmed.chars().count() > 120 {
                let head: String = trimmed.chars().take(120).collect();
                format!("{head}…")
            } else {
                trimmed.to_string()
            };
            matches.push(SearchMatch {
                line: i + 1,
                snippet,
            });
            if matches.len() >= 5 {
                break;
            }
        }
    }
    matches
}

fn mtime_secs(path: &Path) -> i64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
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
        let commit =
            self.git
                .create_commit(&fs_tree, &parent.into_iter().collect::<Vec<_>>(), message)?;
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

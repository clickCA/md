//! History browse and restore over the real git log (the plan's P1
//! "History"): list the commits that touched a note (path-aware, following
//! renames) or the whole vault, read any revision's content, and restore.
//!
//! Restore is deliberately **additive history**: it writes an old revision's
//! content back through the normal note write path, so the restore itself is
//! a normal (commit-and-sync) change and nothing is ever rewritten — no
//! rebase, no force operations, and history stays intact. Deleted notes are
//! resurrected by writing their old content to the same path.

use anyhow::{bail, Context, Result};
use std::collections::BTreeSet;

use crate::git_backend::{CommitMeta, GitBackend, Oid};
use crate::vault::Vault;

/// How a revision changed the note at its path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Added,
    Modified,
    Deleted,
}

impl Change {
    pub fn as_str(&self) -> &'static str {
        match self {
            Change::Added => "added",
            Change::Modified => "modified",
            Change::Deleted => "deleted",
        }
    }
}

/// One entry of a note's history: the commit plus where the note lived at
/// that time (`path` differs from the current path after a rename).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteRevision {
    pub commit: CommitMeta,
    pub change: Change,
    pub path: String,
}

/// Cap on rename-follow hops when tracing history back through renames.
const MAX_RENAME_FOLLOWS: usize = 16;

/// Every commit reachable from `heads` (inclusive), in deterministic order.
fn ancestors(vault: &Vault, heads: &[Oid]) -> Result<BTreeSet<Oid>> {
    let mut seen = BTreeSet::new();
    let mut stack: Vec<Oid> = heads.to_vec();
    while let Some(oid) = stack.pop() {
        if !seen.insert(oid.clone()) {
            continue;
        }
        stack.extend(vault.git.read_commit_parents(&oid)?);
    }
    Ok(seen)
}

/// Blob oid of `path` in `commit`'s tree; `None` when the file is absent.
fn blob_at(vault: &Vault, commit: &Oid, path: &str) -> Result<Option<Oid>> {
    let tree_oid = vault.git.commit_tree_of(commit)?;
    let tree = vault.git.tree_of(&tree_oid)?;
    Ok(tree.get(path).map(|e| e.oid.clone()))
}

/// Blob content of `path` in `commit`'s tree; `None` when absent.
pub fn content_at(vault: &Vault, path: &str, commit: &Oid) -> Result<Option<String>> {
    match blob_at(vault, commit, path)? {
        Some(oid) => {
            let data = vault.git.read_blob(&oid)?;
            Ok(Some(String::from_utf8_lossy(&data).to_string()))
        }
        None => Ok(None),
    }
}

/// Topological depth of every commit in `walk` (root commit = 0). Depth
/// orders history correctly even when commits share a timestamp — tests and
/// fast syncs create several commits within the same second.
fn depths(vault: &Vault, walk: &BTreeSet<Oid>) -> Result<std::collections::HashMap<Oid, u64>> {
    fn depth_of(
        oid: &Oid,
        vault: &Vault,
        memo: &mut std::collections::HashMap<Oid, u64>,
    ) -> Result<u64> {
        if let Some(d) = memo.get(oid) {
            return Ok(*d);
        }
        let mut d = 0;
        for p in vault.git.read_commit_parents(oid)? {
            d = d.max(depth_of(&p, vault, memo)? + 1);
        }
        memo.insert(oid.clone(), d);
        Ok(d)
    }

    let mut memo = std::collections::HashMap::new();
    for oid in walk {
        depth_of(oid, vault, &mut memo)?;
    }
    Ok(memo)
}

/// Change `commit` made to `path`, if any: the blob differs from *every*
/// parent's (a merge that keeps one side unchanged is not a change).
fn change_at(vault: &Vault, commit: &Oid, path: &str, parents: &[Oid]) -> Result<Option<Change>> {
    let mine = blob_at(vault, commit, path)?;
    let mut parent_blobs = Vec::with_capacity(parents.len());
    for p in parents {
        parent_blobs.push(blob_at(vault, p, path)?);
    }
    if !parent_blobs.is_empty() && parent_blobs.iter().all(|b| b.as_ref() == mine.as_ref()) {
        return Ok(None);
    }
    Ok(match &mine {
        // Absent here and absent everywhere before: nothing to report.
        None if parent_blobs.iter().all(|b| b.is_none()) => None,
        None => Some(Change::Deleted),
        Some(_) if parent_blobs.iter().all(|b| b.is_none()) => Some(Change::Added),
        Some(_) => Some(Change::Modified),
    })
}

/// Commits that touched `path` within `allowed`, newest last.
fn segment_entries(
    vault: &Vault,
    path: &str,
    allowed: &BTreeSet<Oid>,
) -> Result<Vec<NoteRevision>> {
    let mut out = Vec::new();
    for oid in allowed {
        let parents = vault.git.read_commit_parents(oid)?;
        if let Some(change) = change_at(vault, oid, path, &parents)? {
            let meta = vault.git.commit_info(oid)?;
            out.push(NoteRevision {
                commit: meta,
                change,
                path: path.to_string(),
            });
        }
    }
    // Oldest first so the caller can reason about rename boundaries. Depth
    // (topology) leads the comparison: same-second commits still order by
    // parent-before-child.
    let depths = depths(vault, allowed)?;
    out.sort_by_key(|e| {
        std::cmp::Reverse((depths[&e.commit.oid], e.commit.time, e.commit.oid.clone()))
    });
    Ok(out)
}

/// The path `new_path` was renamed from at its adding commit: a path that
/// the commit deleted whose content is byte-identical to the added blob.
/// Combined edit+rename (content changed) is not detected — honest MVP.
fn rename_source(vault: &Vault, new_path: &str, added: &NoteRevision) -> Result<Option<String>> {
    let tree_oid = vault.git.commit_tree_of(&added.commit.oid)?;
    let new_tree = vault.git.tree_of(&tree_oid)?;
    let added_blob = blob_at(vault, &added.commit.oid, new_path)?;
    let Some(added_blob) = added_blob else {
        return Ok(None);
    };
    let mut source: Option<String> = None;
    for p in vault.git.read_commit_parents(&added.commit.oid)? {
        let parent_tree_oid = vault.git.commit_tree_of(&p)?;
        let parent_tree = vault.git.tree_of(&parent_tree_oid)?;
        for (path, entry) in &parent_tree {
            if path == new_path || entry.oid != added_blob || new_tree.contains_key(path) {
                continue;
            }
            // Deterministic pick among equally-plausible sources.
            if source.as_ref().is_none_or(|s| path < s) {
                source = Some(path.clone());
            }
        }
    }
    Ok(source)
}

/// History of one note, newest first. Renames are followed backwards: when
/// the oldest entry is the note being added (e.g. by a rename commit), the
/// walk continues under the pre-rename path, and each entry carries the
/// path the note had at that revision.
pub fn note_history(vault: &Vault, path: &str, limit: usize) -> Result<Vec<NoteRevision>> {
    let Some(head) = vault.git.head_oid()? else {
        return Ok(Vec::new());
    };
    let walk = ancestors(vault, &[head])?;

    let mut entries: Vec<NoteRevision> = Vec::new();
    let mut segment_path = path.to_string();
    // Once a rename is followed, only commits *before* the rename commit may
    // contribute further entries for the older path.
    let mut boundary: Option<Oid> = None;

    for _ in 0..=MAX_RENAME_FOLLOWS {
        let allowed = match &boundary {
            Some(b) => {
                let before = vault.git.read_commit_parents(b)?;
                let reachable = ancestors(vault, &before)?;
                walk.intersection(&reachable)
                    .cloned()
                    .collect::<BTreeSet<_>>()
            }
            None => walk.clone(),
        };
        let segment = segment_entries(vault, &segment_path, &allowed)?;
        let Some(oldest) = segment.last().cloned() else {
            break;
        };
        if oldest.change == Change::Added {
            if let Some(old_path) = rename_source(vault, &segment_path, &oldest)? {
                // The adding commit doubles as the old path's deletion point;
                // keep it as this segment's entry and continue before it.
                entries.extend(segment);
                boundary = Some(oldest.commit.oid.clone());
                segment_path = old_path;
                continue;
            }
        }
        entries.extend(segment);
        break;
    }

    // Newest first: topological depth leads, then time.
    let depths = depths(vault, &walk)?;
    entries.sort_by_key(|e| {
        std::cmp::Reverse((depths[&e.commit.oid], e.commit.time, e.commit.oid.clone()))
    });
    entries.truncate(limit);
    Ok(entries)
}

/// History of the whole vault, newest first.
pub fn vault_history(vault: &Vault, limit: usize) -> Result<Vec<CommitMeta>> {
    let Some(head) = vault.git.head_oid()? else {
        return Ok(Vec::new());
    };
    let walk = ancestors(vault, &[head])?;
    let depths = depths(vault, &walk)?;
    let mut out = Vec::with_capacity(walk.len());
    for oid in &walk {
        out.push(vault.git.commit_info(oid)?);
    }
    out.sort_by_key(|c| std::cmp::Reverse((depths[&c.oid], c.time, c.oid.clone())));
    out.truncate(limit);
    Ok(out)
}

/// The note content a history entry refers to. A `Deleted` entry refers to
/// the content the commit removed (its first parent that still has the
/// note), so restoring it resurrects exactly what was lost.
pub fn revision_content(vault: &Vault, rev: &NoteRevision) -> Result<String> {
    if rev.change == Change::Deleted {
        for p in vault.git.read_commit_parents(&rev.commit.oid)? {
            if let Some(content) = content_at(vault, &rev.path, &p)? {
                return Ok(content);
            }
        }
        bail!(
            "{} was deleted at {} but no parent has its content",
            rev.path,
            rev.commit.oid
        );
    }
    content_at(vault, &rev.path, &rev.commit.oid)?
        .ok_or_else(|| anyhow::anyhow!("{} does not exist at {}", rev.path, rev.commit.oid))
}

/// Restore a note from a history entry: writes the entry's revision content
/// back to `current` through the normal write path. Recreates a deleted
/// note; never rewrites history — the restore itself is a normal
/// (commit-and-sync) change.
pub fn restore_revision(vault: &Vault, current: &str, rev: &NoteRevision) -> Result<()> {
    let content = revision_content(vault, rev)?;
    vault
        .write_note(current, &content)
        .context("restore: writing revision content")
}

/// Restore every note present at `commit` (vault-level restore). Notes
/// created after the revision are left alone — restore never deletes, so
/// the result is a normal forward change per note.
pub fn restore_snapshot(vault: &Vault, commit: &Oid) -> Result<usize> {
    let tree_oid = vault.git.commit_tree_of(commit)?;
    let tree = vault.git.tree_of(&tree_oid)?;
    let mut restored = 0;
    for path in tree.keys() {
        if !path.ends_with(".md") {
            continue;
        }
        let content = content_at(vault, path, commit)?
            .context("snapshot entry vanished mid-restore (concurrent write?)")?;
        vault.write_note(path, &content)?;
        restored += 1;
    }
    Ok(restored)
}

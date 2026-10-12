use crate::git_backend::GitBackend;
use crate::merge::{flatten_blobs, try_line_merge};
use crate::vault::Vault;
use anyhow::{anyhow, Result};
use std::collections::BTreeMap;

#[derive(Debug)]
pub struct ConflictRecord {
    pub path: String,
    pub conflict_copy: String,
    pub winner: String,
}

#[derive(Debug)]
pub struct SyncOutcome {
    pub action: String,
    pub head: Option<String>,
    pub remote: Option<String>,
    pub conflicts: Vec<ConflictRecord>,
}

fn abort_point(state: &str) {
    if let Ok(s) = std::env::var("VAULT_SPIKE_ABORT_STATE") {
        if s == state {
            eprintln!("VAULT_SPIKE_ABORT_STATE={state}: aborting");
            std::process::abort();
        }
    }
}

fn winner_key(time: i64, oid: &str) -> (i64, String) {
    (time, oid.to_string())
}

pub fn sync(vault: &Vault) -> Result<SyncOutcome> {
    let run = vault.db.begin_run()?;
    let result = sync_inner(vault, run);
    match &result {
        Ok(outcome) => {
            let o = if outcome.conflicts.is_empty() { "ok" } else { "conflicts" };
            let _ = vault.db.finish_run(run, o, &outcome.action);
        }
        Err(e) => {
            let _ = vault.db.finish_run(run, "error", &e.to_string());
        }
    }
    result
}

fn sync_inner(vault: &Vault, run: i64) -> Result<SyncOutcome> {
    vault.commit_pending("auto: pending changes")?;
    let local = vault.git.head_oid()?;
    vault.db.event(run, "fetching")?;
    let remote = vault.git.fetch()?;
    abort_point("fetching");

    let (local, remote) = match (local, remote) {
        (None, None) => return Err(anyhow!("nothing to sync: no local or remote history")),
        (None, Some(r)) => {
            fast_forward(vault, &r)?;
            return Ok(SyncOutcome {
                action: "fast-forward (initial)".into(),
                head: Some(r.clone()),
                remote: Some(r),
                conflicts: Vec::new(),
            });
        }
        (Some(l), None) => {
            push(vault, run, &l)?;
            return Ok(SyncOutcome {
                action: "push (initial)".into(),
                head: Some(l.clone()),
                remote: Some(l),
                conflicts: Vec::new(),
            });
        }
        (Some(l), Some(r)) => (l, r),
    };

    if local == remote {
        return Ok(SyncOutcome {
            action: "up-to-date".into(),
            head: Some(local),
            remote: Some(remote),
            conflicts: Vec::new(),
        });
    }

    vault.db.event(run, "merging")?;
    let mb = vault
        .git
        .merge_base(&local, &remote)?
        .ok_or_else(|| anyhow!("histories are unrelated; refusing to merge"))?;

    if mb == remote {
        push(vault, run, &local)?;
        return Ok(SyncOutcome {
            action: "push".into(),
            head: Some(local.clone()),
            remote: Some(local),
            conflicts: Vec::new(),
        });
    }

    if mb == local {
        fast_forward(vault, &remote)?;
        return Ok(SyncOutcome {
            action: "fast-forward".into(),
            head: Some(remote.clone()),
            remote: Some(remote),
            conflicts: Vec::new(),
        });
    }

    let base_tree = flatten_blobs(&vault.git.tree_of(&vault.git.commit_tree_of(&mb)?)?);
    let ours_tree = flatten_blobs(&vault.git.tree_of(&vault.git.commit_tree_of(&local)?)?);
    let theirs_tree = flatten_blobs(&vault.git.tree_of(&vault.git.commit_tree_of(&remote)?)?);

    let ours_time = vault.git.commit_time(&local)?;
    let theirs_time = vault.git.commit_time(&remote)?;
    let ours_wins = winner_key(ours_time, &local) > winner_key(theirs_time, &remote);

    let mut merged: BTreeMap<String, String> = BTreeMap::new();
    let mut conflicts: Vec<ConflictRecord> = Vec::new();
    let mut paths: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    paths.extend(base_tree.keys().cloned());
    paths.extend(ours_tree.keys().cloned());
    paths.extend(theirs_tree.keys().cloned());

    for path in paths {
        let b = base_tree.get(&path);
        let o = ours_tree.get(&path);
        let t = theirs_tree.get(&path);
        for (entry_path, oid) in merge_path(vault, &path, b, o, t, ours_wins, &mut conflicts)? {
            merged.insert(entry_path, oid);
        }
    }
    abort_point("merging");

    vault.materialize(&merged)?;
    for c in &conflicts {
        let _ = vault.db.record_conflict(&c.path, &c.conflict_copy, &c.winner);
    }

    vault.db.event(run, "committing")?;
    let tree = tree_from_blobs(&merged);
    let commit = vault.git.create_commit(&tree, &[local.clone(), remote.clone()], "merge origin/main")?;
    vault.git.update_main(&commit)?;
    abort_point("committing");

    push(vault, run, &commit)?;
    Ok(SyncOutcome {
        action: "merge".into(),
        head: Some(commit.clone()),
        remote: Some(commit),
        conflicts,
    })
}

fn push(vault: &Vault, run: i64, oid: &str) -> Result<()> {
    vault.db.event(run, "pushing")?;
    vault.git.push_main(&oid.to_string())?;
    abort_point("pushing");
    Ok(())
}

fn fast_forward(vault: &Vault, remote: &str) -> Result<()> {
    let tree = flatten_blobs(&vault.git.tree_of(&vault.git.commit_tree_of(&remote.to_string())?)?);
    vault.materialize(&tree)?;
    vault.git.update_main(&remote.to_string())?;
    Ok(())
}

fn tree_from_blobs(blobs: &BTreeMap<String, String>) -> crate::git_backend::Tree {
    blobs
        .iter()
        .map(|(p, oid)| {
            (
                p.clone(),
                crate::git_backend::TreeEntry { oid: oid.clone(), is_dir: false },
            )
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn merge_path(
    vault: &Vault,
    path: &str,
    b: Option<&String>,
    o: Option<&String>,
    t: Option<&String>,
    ours_wins: bool,
    conflicts: &mut Vec<ConflictRecord>,
) -> Result<Vec<(String, String)>> {
    if o == t {
        return Ok(o.map(|oid| (path.to_string(), oid.clone())).into_iter().collect());
    }
    let ours_changed = o != b;
    let theirs_changed = t != b;
    if !ours_changed {
        return Ok(t.map(|oid| (path.to_string(), oid.clone())).into_iter().collect());
    }
    if !theirs_changed {
        return Ok(o.map(|oid| (path.to_string(), oid.clone())).into_iter().collect());
    }

    if let (Some(o_oid), Some(t_oid)) = (o, t) {
        let base = b.map(|oid| vault.git.read_blob(oid)).transpose()?;
        let ours = vault.git.read_blob(o_oid)?;
        let theirs = vault.git.read_blob(t_oid)?;
        if let Some(merged) = try_line_merge(base.as_deref().unwrap_or_default(), &ours, &theirs) {
            let oid = vault.git.write_blob(&merged)?;
            return Ok(vec![(path.to_string(), oid)]);
        }
    }

    let (winner_oid, loser_content, winner_label) = match (o, t) {
        (None, Some(t_oid)) => (
            t_oid.clone(),
            b.map(|oid| vault.git.read_blob(oid)).transpose()?.unwrap_or_default(),
            "theirs (ours deleted)",
        ),
        (Some(o_oid), None) => (
            o_oid.clone(),
            b.map(|oid| vault.git.read_blob(oid)).transpose()?.unwrap_or_default(),
            "ours (theirs deleted)",
        ),
        (Some(o_oid), Some(t_oid)) => {
            if ours_wins {
                (
                    o_oid.clone(),
                    vault.git.read_blob(t_oid)?,
                    "ours",
                )
            } else {
                (
                    t_oid.clone(),
                    vault.git.read_blob(o_oid)?,
                    "theirs",
                )
            }
        }
        (None, None) => unreachable!("both unchanged cannot reach here"),
    };

    let copy_path = conflict_copy_name(path);
    let copy_oid = vault.git.write_blob(&loser_content)?;
    conflicts.push(ConflictRecord {
        path: path.to_string(),
        conflict_copy: copy_path.clone(),
        winner: winner_label.to_string(),
    });
    Ok(vec![(path.to_string(), winner_oid), (copy_path, copy_oid)])
}

fn conflict_copy_name(path: &str) -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default();
    match path.strip_suffix(".md") {
        Some(stem) => format!("{stem}.conflict-{ts}.md"),
        None => format!("{path}.conflict-{ts}.md"),
    }
}

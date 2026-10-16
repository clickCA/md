use crate::git_backend::{GitBackend, Oid, Tree, TreeEntry};
use anyhow::{anyhow, Context, Result};
use gix::actor::Signature;
use gix::bstr::ByteSlice;
use gix::objs::tree::{Entry, EntryMode};
use gix::objs::{Commit, Tree as ObjectTree};
use gix::refs::transaction::PreviousValue;
use gix::refs::Target;
use gix::remote::Direction;
use std::collections::BTreeMap;
use std::path::Path;

pub struct GixBackend {
    repo: gix::Repository,
}

const MAIN: &str = "refs/heads/main";
const ORIGIN_MAIN: &str = "refs/remotes/origin/main";

fn sig() -> Signature {
    Signature {
        name: "md-sync".into(),
        email: "md@localhost".into(),
        time: gix::date::Time::now_local_or_utc(),
    }
}

fn to_hex(oid: gix::ObjectId) -> Oid {
    oid.to_hex().to_string()
}

fn from_hex(oid: &Oid) -> Result<gix::ObjectId> {
    gix::hash::ObjectId::from_hex(oid.as_bytes())
        .map_err(|e| anyhow!("invalid oid {oid}: {e:?}"))
}

fn ref_target_oid(r: &gix::Reference<'_>) -> Option<gix::ObjectId> {
    match r.target() {
        gix::refs::TargetRef::Object(id) => Some(id.to_owned()),
        gix::refs::TargetRef::Symbolic(_) => None,
    }
}

enum Node {
    Dir(BTreeMap<String, Node>),
    Blob(gix::hash::ObjectId),
}

fn insert_path(root: &mut BTreeMap<String, Node>, path: &str, oid: gix::hash::ObjectId) {
    match path.split_once('/') {
        Some((first, rest)) => {
            let node = root
                .entry(first.to_string())
                .or_insert_with(|| Node::Dir(BTreeMap::new()));
            if let Node::Dir(map) = node {
                insert_path(map, rest, oid);
            }
        }
        None => {
            root.insert(path.to_string(), Node::Blob(oid));
        }
    }
}

fn write_node(repo: &gix::Repository, map: &BTreeMap<String, Node>) -> Result<gix::hash::ObjectId> {
    let mut entries: Vec<Entry> = Vec::new();
    for (name, node) in map {
        match node {
            Node::Dir(sub) => {
                let oid = write_node(repo, sub)?;
                entries.push(Entry {
                    mode: EntryMode::from(gix::objs::tree::EntryKind::Tree),
                    filename: name.as_bytes().as_bstr().to_owned(),
                    oid,
                });
            }
            Node::Blob(oid) => {
                entries.push(Entry {
                    mode: EntryMode::from(gix::objs::tree::EntryKind::Blob),
                    filename: name.as_bytes().as_bstr().to_owned(),
                    oid: *oid,
                });
            }
        }
    }
    entries.sort();
    let obj = ObjectTree { entries };
    Ok(repo.write_object(&obj)?.detach())
}

impl GixBackend {
    fn write_tree_object(&self, tree: &Tree) -> Result<Oid> {
        let mut root: BTreeMap<String, Node> = BTreeMap::new();
        for (path, entry) in tree {
            if entry.is_dir {
                continue;
            }
            insert_path(&mut root, path, from_hex(&entry.oid)?);
        }
        Ok(to_hex(write_node(&self.repo, &root)?))
    }
}

impl GixBackend {
    fn prepare(repo: gix::Repository) -> Result<Self> {
        let mut repo = repo;
        repo.committer_or_set_generic_fallback()
            .context("set committer fallback")?;
        Ok(Self { repo })
    }
}

impl GitBackend for GixBackend {
    fn init(path: &Path) -> Result<Self> {
        let repo = gix::init(path)?;
        Self::prepare(repo)
    }

    fn init_bare(path: &Path) -> Result<Self> {
        let repo = gix::init_bare(path)?;
        Self::prepare(repo)
    }

    fn open(path: &Path) -> Result<Self> {
        let repo = gix::open_opts(path, gix::open::Options::isolated())?;
        Self::prepare(repo)
    }

    fn set_remote(&mut self, url: &str) -> Result<()> {
        let config_path = self.repo.git_dir().join("config");
        let open_path = self
            .repo
            .workdir()
            .unwrap_or_else(|| self.repo.git_dir())
            .to_path_buf();
        let mut file = self.repo.config_file_mut(&config_path)?;
        file.set_raw_value_by(
            "remote",
            Some("origin".as_bytes().as_bstr()),
            "url",
            url.as_bytes().as_bstr(),
        )?;
        file.set_raw_value_by(
            "remote",
            Some("origin".as_bytes().as_bstr()),
            "fetch",
            "+refs/heads/*:refs/remotes/origin/*".as_bytes().as_bstr(),
        )?;
        file.commit()?;
        self.repo = gix::open_opts(open_path, gix::open::Options::isolated())?;
        self.repo
            .committer_or_set_generic_fallback()
            .context("set committer fallback")?;
        Ok(())
    }

    fn remote_url(&self) -> Result<Option<String>> {
        match self.repo.try_find_remote("origin") {
            Some(Ok(remote)) => Ok(remote.url(Direction::Fetch).map(|u| u.to_string())),
            _ => Ok(None),
        }
    }

    fn head_oid(&self) -> Result<Option<Oid>> {
        Ok(self
            .repo
            .try_find_reference(MAIN)?
            .and_then(|r| ref_target_oid(&r).map(to_hex)))
    }

    fn remote_main_oid(&self) -> Result<Option<Oid>> {
        Ok(self
            .repo
            .try_find_reference(ORIGIN_MAIN)?
            .and_then(|r| ref_target_oid(&r).map(to_hex)))
    }

    fn fetch(&self) -> Result<Option<Oid>> {
        let remote = self.repo.find_remote("origin")?;
        let prep = remote
            .connect(Direction::Fetch)?
            .prepare_fetch(gix::progress::Discard, Default::default())
            .context("prepare_fetch")?;
        prep.receive(gix::progress::Discard, &gix::interrupt::IS_INTERRUPTED)
            .context("fetch receive")?;
        drop(remote);
        self.remote_main_oid()
    }

    fn push_main(&self, expected_local: &Oid) -> Result<()> {
        let workdir = self
            .repo
            .workdir()
            .ok_or_else(|| anyhow!("push requires a worktree repository"))?
            .to_path_buf();
        let repo = git2::Repository::open(&workdir)?;
        let mut remote = repo.find_remote("origin")?;
        let mut cbs = git2::RemoteCallbacks::new();
        let rejected = std::rc::Rc::new(std::cell::RefCell::new(Vec::<String>::new()));
        let rejected_c = rejected.clone();
        cbs.push_update_reference(move |refname, status| {
            if let Some(msg) = status {
                rejected_c
                    .borrow_mut()
                    .push(format!("{refname}: {msg}"));
            }
            Ok(())
        });
        let mut opts = git2::PushOptions::new();
        opts.remote_callbacks(cbs);
        remote
            .push(&["refs/heads/main:refs/heads/main"], Some(&mut opts))
            .context("libgit2 push")?;
        let rejected = rejected.borrow();
        if !rejected.is_empty() {
            return Err(anyhow!("push rejected: {}", rejected.join("; ")));
        }
        remote.disconnect()?;
        drop(remote);
        drop(repo);
        let actual = self.fetch()?;
        if actual.as_deref() != Some(expected_local.as_str()) {
            return Err(anyhow!(
                "remote tip diverged after push: expected {expected_local}, got {:?}",
                actual
            ));
        }
        Ok(())
    }

    fn merge_base(&self, a: &Oid, b: &Oid) -> Result<Option<Oid>> {
        let oid = self
            .repo
            .merge_base(from_hex(a)?, from_hex(b)?)
            .context("merge_base")?;
        Ok(oid.map(|id| to_hex(id.detach())))
    }

    fn commit_tree_of(&self, commit: &Oid) -> Result<Oid> {
        let obj = self.repo.find_object(from_hex(commit)?)?;
        let commit = obj.try_into_commit()?;
        Ok(to_hex(commit.tree_id()?.detach()))
    }

    fn commit_time(&self, commit: &Oid) -> Result<i64> {
        let obj = self.repo.find_object(from_hex(commit)?)?;
        let commit = obj.try_into_commit()?;
        Ok(commit.time()?.seconds)
    }

    fn read_commit_parents(&self, commit: &Oid) -> Result<Vec<Oid>> {
        let obj = self.repo.find_object(from_hex(commit)?)?;
        let commit = obj.try_into_commit()?;
        Ok(commit.parent_ids().map(|id| to_hex(id.detach())).collect())
    }

    fn tree_of(&self, tree_oid: &Oid) -> Result<Tree> {
        let tree = self.repo.find_tree(from_hex(tree_oid)?)?;
        let mut map = Tree::new();
        for entry in tree.iter() {
            let entry = entry?;
            let name = String::from_utf8_lossy(entry.inner.filename).to_string();
            if entry.inner.mode.is_tree() {
                let sub = self.tree_of(&to_hex(entry.inner.oid.to_owned()))?;
                for (p, e) in sub {
                    map.insert(format!("{name}/{p}"), e);
                }
            } else {
                map.insert(
                    name,
                    TreeEntry { oid: to_hex(entry.inner.oid.to_owned()), is_dir: false },
                );
            }
        }
        Ok(map)
    }

    fn read_blob(&self, oid: &Oid) -> Result<Vec<u8>> {
        let blob = self.repo.find_blob(from_hex(oid)?)?;
        Ok(blob.data.to_vec())
    }

    fn write_blob(&self, data: &[u8]) -> Result<Oid> {
        Ok(to_hex(self.repo.write_blob(data)?.detach()))
    }

    fn create_commit(&self, tree: &Tree, parents: &[Oid], message: &str) -> Result<Oid> {
        let root_oid = self.write_tree_object(tree)?;
        let commit = Commit {
            message: message.into(),
            tree: from_hex(&root_oid)?,
            author: sig(),
            committer: sig(),
            encoding: None,
            parents: parents
                .iter()
                .map(|p| from_hex(p))
                .collect::<Result<Vec<_>>>()?
                .into(),
            extra_headers: Default::default(),
        };
        Ok(to_hex(self.repo.write_object(&commit)?.detach()))
    }

    fn update_main(&self, commit: &Oid) -> Result<()> {
        let edit = gix::refs::transaction::RefEdit::update(
            MAIN.try_into()?,
            Target::Object(from_hex(commit)?),
            PreviousValue::Any,
            "md-sync",
        );
        self.repo.edit_reference(edit)?;
        Ok(())
    }

    fn head_tree(&self) -> Result<Tree> {
        match self.head_oid()? {
            Some(head) => {
                let tree_oid = self.commit_tree_of(&head)?;
                self.tree_of(&tree_oid)
            }
            None => Ok(Tree::new()),
        }
    }
}

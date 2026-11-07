use crate::git_backend::{CommitMeta, Credentials, GitBackend, Oid, Tree, TreeEntry};
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

#[cfg(target_os = "android")]
mod android_tls {
    use anyhow::{anyhow, Result};
    use std::any::Any;
    use std::sync::{Arc, Mutex};

    type HttpOptions = gix::protocol::transport::client::blocking_io::http::Options;
    type ReqwestOptions = gix::protocol::transport::client::blocking_io::http::reqwest::Options;

    /// The OS trust store on device: Android ships its CA bundle as PEM files
    /// in `/system/etc/security/cacerts` (plus the Conscrypt APEX path on
    /// newer releases, which may carry an updated set).
    fn trusted_certs() -> Result<Vec<reqwest::tls::Certificate>> {
        let mut out = Vec::new();
        for dir in [
            "/system/etc/security/cacerts",
            "/apex/com.android.conscrypt/cacerts",
        ] {
            let entries = match std::fs::read_dir(dir) {
                Ok(rd) => rd,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let Ok(bytes) = std::fs::read(entry.path()) else {
                    continue;
                };
                // Each file is one or more PEM certificates; bundle handles both.
                if let Ok(certs) = reqwest::tls::Certificate::from_pem_bundle(&bytes) {
                    out.extend(certs);
                }
            }
        }
        if out.is_empty() {
            return Err(anyhow!(
                "no CA certificates found on device (looked in /system/etc/security/cacerts)"
            ));
        }
        Ok(out)
    }

    /// HTTP transport options for Android.
    ///
    /// reqwest's rustls backend drives `rustls-platform-verifier`, which on
    /// Android needs a Gradle/JNI integration (an AAR + init call from the
    /// app's Java side) that Tauri apps don't provide — so every HTTPS request
    /// dies with "prepare_fetch failed: Transport handshake failed". Route
    /// around it: hand the transport explicit options that build the reqwest
    /// client from the on-device PEM bundle instead, no JVM required. Desktop
    /// is untouched (the platform verifier works there).
    pub fn options() -> Result<Box<dyn Any>> {
        let certs = trusted_certs()?;
        let mut backend = ReqwestOptions::default();
        backend.configure_client = Some(Box::new(move |builder| {
            Ok(builder.tls_certs_only(certs.clone()))
        }));
        Ok(Box::new(HttpOptions {
            backend: Some(Arc::new(Mutex::new(backend))),
            ..HttpOptions::default()
        }))
    }
}

/// libgit2's TLS stack on Android cannot read CA files at all.
///
/// `openssl-src` builds OpenSSL with `no-stdio` for Android (it hardcodes the
/// flag for this target), so `SSL_CTX_load_verify_locations` — and therefore
/// libgit2's `GIT_OPT_SET_SSL_CERT_LOCATIONS` — fails with
/// "x509 certificate routines::BIO lib" and every HTTPS push dies at
/// certificate verification. Feed the system trust store in as X509 objects
/// instead: libgit2's `GIT_OPT_ADD_SSL_X509_CERT` stores a cert without touching
/// the filesystem, and `d2i_X509` is the DER parser of the very OpenSSL build
/// libgit2 links.
#[cfg(target_os = "android")]
mod android_ca {
    use base64::Engine as _;
    use std::ffi::c_void;
    use std::sync::Once;

    /// Directory trust store is only read here, then handed to libgit2 in
    /// memory; nothing is written to disk.
    const STORES: [&str; 2] = [
        "/system/etc/security/cacerts",
        "/apex/com.android.conscrypt/cacerts",
    ];

    extern "C" {
        fn d2i_X509(
            cert: *mut *mut c_void,
            inp: *mut *const u8,
            len: std::ffi::c_long,
        ) -> *mut c_void;
        fn X509_free(cert: *mut c_void);
    }

    /// Decode one PEM certificate into DER.
    fn pem_blocks(pem: &str) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        let mut b64 = String::new();
        let mut inside = false;
        for line in pem.lines() {
            let line = line.trim();
            if line == "-----BEGIN CERTIFICATE-----" {
                inside = true;
                b64.clear();
            } else if line == "-----END CERTIFICATE-----" {
                if inside {
                    if let Ok(der) = base64::engine::general_purpose::STANDARD.decode(&b64) {
                        out.push(der);
                    }
                }
                inside = false;
            } else if inside {
                b64.push_str(line);
            }
        }
        out
    }

    /// Add a DER certificate to libgit2's OpenSSL store.
    fn add_der(der: &[u8]) -> bool {
        let mut cursor = der.as_ptr();
        // SAFETY: `cursor` is valid for `der.len()` bytes for the call.
        let x509 = unsafe { d2i_X509(std::ptr::null_mut(), &mut cursor, der.len() as _) };
        if x509.is_null() {
            return false;
        }
        // SAFETY: `x509` is a live X509; libgit2 retains its own reference in
        // the store, so releasing ours afterwards is correct.
        let rc = unsafe {
            libgit2_sys::git_libgit2_opts(
                libgit2_sys::GIT_OPT_ADD_SSL_X509_CERT as i32,
                x509 as *const c_void,
            )
        };
        unsafe { X509_free(x509) };
        rc == 0
    }

    /// Install the device's CA certificates into libgit2 once per process.
    /// Must run after libgit2 is initialized (any `git2::Repository` call).
    pub fn install() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            for dir in STORES {
                let Ok(entries) = std::fs::read_dir(dir) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let Ok(pem) = std::fs::read_to_string(entry.path()) else {
                        continue;
                    };
                    for der in pem_blocks(&pem) {
                        // Duplicates across the two store locations fail to add;
                        // that is harmless and already-covered certs stay.
                        let _ = add_der(&der);
                    }
                }
            }
        });
    }
}

pub struct GixBackend {
    repo: gix::Repository,
}

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
    gix::hash::ObjectId::from_hex(oid.as_bytes()).map_err(|e| anyhow!("invalid oid {oid}: {e:?}"))
}

/// Resolve credentials for `url` the same way `git` does: by asking the
/// configured credential helpers (global + repo-local, e.g. the libsecret
/// keychain) via libgit2, which reads the full git configuration. Never prompts
/// on a terminal; returns `None` when nothing usable is stored so the caller can
/// surface the typed "authentication required" error and let the UI ask instead.
fn helper_credentials(workdir: &Path, url: &str) -> Option<Credentials> {
    let repo = git2::Repository::open(workdir).ok()?;
    let cfg = repo.config().ok()?;
    git2::CredentialHelper::new(url)
        .config(&cfg)
        .username(None)
        .execute()
        .map(|(username, password)| Credentials { username, password })
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
    /// Resolve credentials for `remote`: explicit credentials win, otherwise
    /// fall back to git's own credential helpers for https remotes — the same
    /// helpers `git fetch`/`git push` use — so a token already stored locally
    /// (e.g. in the libsecret keychain) is reused instead of prompting on
    /// every sync. Non-https remotes (`file://`, ssh, …) are left untouched.
    fn resolve_credentials(
        &self,
        creds: Option<&Credentials>,
        remote: &str,
    ) -> Result<Option<Credentials>> {
        if let Some(c) = creds {
            return Ok(Some(c.clone()));
        }
        let Some(workdir) = self.repo.workdir() else {
            return Ok(None);
        };
        let Some(url) = self
            .repo
            .find_remote(remote)?
            .url(Direction::Fetch)
            .map(|u| u.to_string())
        else {
            return Ok(None);
        };
        if !url.starts_with("https://") && !url.starts_with("http://") {
            return Ok(None);
        }
        Ok(helper_credentials(workdir, &url))
    }

    fn push_refspec(
        &self,
        remote: &str,
        expected_local: &Oid,
        creds: Option<&Credentials>,
        force: bool,
    ) -> Result<()> {
        let workdir = self
            .repo
            .workdir()
            .ok_or_else(|| anyhow!("push requires a worktree repository"))?
            .to_path_buf();
        let repo = git2::Repository::open(&workdir)?;
        // libgit2's OpenSSL on Android is built without stdio, so it cannot read
        // CA files — feed the system trust store in as X509 objects instead.
        #[cfg(target_os = "android")]
        android_ca::install();
        let mut r = repo.find_remote(remote)?;
        let mut cbs = git2::RemoteCallbacks::new();
        let rejected = std::rc::Rc::new(std::cell::RefCell::new(Vec::<String>::new()));
        let rejected_c = rejected.clone();
        cbs.push_update_reference(move |refname, status| {
            if let Some(msg) = status {
                rejected_c.borrow_mut().push(format!("{refname}: {msg}"));
            }
            Ok(())
        });
        // Reuse git's own credential storage when no explicit credentials were
        // supplied, so sync doesn't prompt on every push — mirroring what `git
        // push` would do. The resolved creds also feed the verification fetch
        // below, which previously always failed on `None` even after a
        // successful push.
        let creds = self.resolve_credentials(creds, remote)?;
        let creds_v = creds.clone();
        cbs.credentials(move |_url, _username, _allowed| {
            if let Some(c) = &creds_v {
                return git2::Cred::userpass_plaintext(&c.username, &c.password);
            }
            Err(git2::Error::from_str("authentication required"))
        });
        let mut opts = git2::PushOptions::new();
        opts.remote_callbacks(cbs);
        let branch = self.current_branch()?;
        let force_char = if force { "+" } else { "" };
        let refspec = format!("{force_char}refs/heads/{branch}:refs/heads/{branch}");
        r.push(&[refspec], Some(&mut opts))
            .context("libgit2 push")?;
        let rejected = rejected.borrow();
        if !rejected.is_empty() {
            return Err(anyhow!("push rejected: {}", rejected.join("; ")));
        }
        r.disconnect()?;
        drop(r);
        drop(repo);
        let actual = self.fetch_from(remote, creds.as_ref())?;
        if actual.as_deref() != Some(expected_local.as_str()) {
            return Err(anyhow!(
                "remote tip diverged after push: expected {expected_local}, got {:?}",
                actual
            ));
        }
        Ok(())
    }

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
    /// Reopen the repository after raw config mutations.
    fn reopen(&mut self, open_path: Option<std::path::PathBuf>) -> Result<()> {
        let open_path = open_path.or_else(|| self.repo.workdir().map(|p| p.to_path_buf()));
        let path = open_path.unwrap_or_else(|| self.repo.git_dir().to_path_buf());
        self.repo = gix::open_opts(path, gix::open::Options::isolated())?;
        self.repo
            .committer_or_set_generic_fallback()
            .context("reopen repository")?;
        Ok(())
    }

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

    fn set_remote(&mut self, name: &str, url: &str) -> Result<()> {
        let open_path = self.repo.workdir().map(|p| p.to_path_buf());
        let config_path = self.repo.git_dir().join("config");
        let mut file = self.repo.config_file_mut(&config_path)?;
        file.set_raw_value_by(
            "remote",
            Some(name.as_bytes().as_bstr()),
            "url",
            url.as_bytes().as_bstr(),
        )?;
        file.set_raw_value_by(
            "remote",
            Some(name.as_bytes().as_bstr()),
            "fetch",
            format!("+refs/heads/*:refs/remotes/{name}/*")
                .as_bytes()
                .as_bstr(),
        )?;
        file.commit()?;
        self.reopen(open_path)?;
        Ok(())
    }

    fn remote_url(&self) -> Result<Option<String>> {
        let primary = self.primary_remote()?;
        self.remote_url_of(&primary)
    }

    fn remote_url_of(&self, name: &str) -> Result<Option<String>> {
        match self.repo.try_find_remote(name) {
            Some(Ok(remote)) => Ok(remote.url(Direction::Fetch).map(|u| u.to_string())),
            _ => Ok(None),
        }
    }

    fn list_remotes(&self) -> Result<Vec<(String, String)>> {
        let workdir = self
            .repo
            .workdir()
            .ok_or_else(|| anyhow!("requires a worktree repository"))?
            .to_path_buf();
        let repo = git2::Repository::open(&workdir)?;
        let mut out = Vec::new();
        for entry in repo.remotes()?.iter() {
            // git2 yields Result<Option<&str>> per entry — skip oddities.
            let Some(name) = entry.ok().flatten() else {
                continue;
            };
            if let Ok(r) = repo.find_remote(name) {
                let url = r.url().unwrap_or_default().to_string();
                out.push((name.to_string(), url));
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    }

    fn add_remote(&mut self, name: &str, url: &str) -> Result<()> {
        let open_path = self.repo.workdir().map(|p| p.to_path_buf());
        let workdir = self
            .repo
            .workdir()
            .ok_or_else(|| anyhow!("requires a worktree repository"))?
            .to_path_buf();
        let repo = git2::Repository::open(&workdir)?;
        repo.remote(name, url).context("add remote")?;
        drop(repo);
        self.reopen(open_path)?;
        Ok(())
    }

    fn remove_remote(&mut self, name: &str) -> Result<()> {
        let open_path = self.repo.workdir().map(|p| p.to_path_buf());
        let workdir = self
            .repo
            .workdir()
            .ok_or_else(|| anyhow!("requires a worktree repository"))?
            .to_path_buf();
        let repo = git2::Repository::open(&workdir)?;
        repo.remote_delete(name).context("remove remote")?;
        drop(repo);
        self.reopen(open_path)?;
        // A removed remote can't stay primary.
        if self.primary_remote()? == name {
            self.set_primary_remote("origin")?;
        }
        Ok(())
    }

    fn rename_remote(&mut self, old: &str, new: &str) -> Result<()> {
        let open_path = self.repo.workdir().map(|p| p.to_path_buf());
        let workdir = self
            .repo
            .workdir()
            .ok_or_else(|| anyhow!("requires a worktree repository"))?
            .to_path_buf();
        let repo = git2::Repository::open(&workdir)?;
        repo.remote_rename(old, new).context("rename remote")?;
        drop(repo);
        self.reopen(open_path)?;
        // Keep the primary designation attached through the rename.
        if self.primary_remote()? == old {
            self.set_primary_remote(new)?;
        }
        Ok(())
    }

    fn primary_remote(&self) -> Result<String> {
        let workdir = self
            .repo
            .workdir()
            .ok_or_else(|| anyhow!("requires a worktree repository"))?
            .to_path_buf();
        let repo = git2::Repository::open(&workdir)?;
        let stored = repo
            .config()
            .and_then(|c| c.get_string("quire.primaryRemote"))
            .ok();
        drop(repo);
        let primary = stored.unwrap_or_else(|| "origin".to_string());
        // A primary that no longer exists falls back to the first remote.
        let remotes = self.list_remotes()?;
        if remotes.iter().any(|(name, _)| name == &primary) {
            return Ok(primary);
        }
        Ok(remotes
            .first()
            .map(|(name, _)| name.clone())
            .unwrap_or_else(|| "origin".to_string()))
    }

    fn set_primary_remote(&mut self, name: &str) -> Result<()> {
        if !self.list_remotes()?.iter().any(|(n, _)| n == name) {
            anyhow::bail!("no such remote: {name}");
        }
        let workdir = self
            .repo
            .workdir()
            .ok_or_else(|| anyhow!("requires a worktree repository"))?
            .to_path_buf();
        let repo = git2::Repository::open(&workdir)?;
        let mut cfg = repo.config()?;
        cfg.set_str("quire.primaryRemote", name)?;
        Ok(())
    }

    fn current_branch(&self) -> Result<String> {
        let Some(head) = self.repo.try_find_reference("HEAD")? else {
            return Ok("main".to_string());
        };
        let short = head
            .target()
            .try_name()
            .and_then(|name| name.as_bstr().to_str().ok())
            .and_then(|name| name.strip_prefix("refs/heads/"))
            .map(str::to_string);
        Ok(short.unwrap_or_else(|| "main".to_string()))
    }

    fn list_branches(&self) -> Result<Vec<String>> {
        let mut out = Vec::new();
        for r in self.repo.references()?.all()? {
            let r = r?;
            let name = r.name().as_bstr().to_str().unwrap_or_default().to_string();
            if let Some(short) = name.strip_prefix("refs/heads/") {
                out.push(short.to_string());
            }
        }
        out.sort();
        Ok(out)
    }

    fn branch_oid(&self, branch: &str) -> Result<Option<Oid>> {
        Ok(self
            .repo
            .try_find_reference(format!("refs/heads/{branch}").as_str())?
            .and_then(|r| ref_target_oid(&r).map(to_hex)))
    }

    fn create_branch(&self, branch: &str, at: Option<&Oid>) -> Result<()> {
        let at = match at {
            Some(oid) => oid.clone(),
            None => self
                .head_oid()?
                .ok_or_else(|| anyhow!("cannot create a branch before the first commit"))?,
        };
        let edit = gix::refs::transaction::RefEdit::update(
            gix::refs::FullName::try_from(format!("refs/heads/{branch}"))?,
            Target::Object(from_hex(&at)?),
            PreviousValue::Any,
            "md: create branch",
        );
        self.repo.edit_reference(edit)?;
        Ok(())
    }

    fn set_head_branch(&self, branch: &str) -> Result<()> {
        let edit = gix::refs::transaction::RefEdit::update(
            "HEAD".try_into()?,
            Target::Symbolic(format!("refs/heads/{branch}").try_into()?),
            PreviousValue::Any,
            "md: switch branch",
        );
        self.repo.edit_reference(edit)?;
        Ok(())
    }

    fn remote_branch_oid(&self, branch: &str) -> Result<Option<Oid>> {
        let primary = self.primary_remote()?;
        self.remote_branch_oid_at(&primary, branch)
    }

    fn remote_branch_oid_at(&self, remote: &str, branch: &str) -> Result<Option<Oid>> {
        // `refs/remotes/<remote>/HEAD` is ambiguous: in a normal clone it is
        // a symref to the default branch, but the refspec `+refs/heads/*` also
        // maps a remote branch literally named `HEAD` onto it — shadowing the
        // real tip with a stale oid (seen in the wild). Prefer the explicit
        // branch ref; keep the legacy fallbacks for the default branch.
        let mut names = vec![format!("refs/remotes/{remote}/{branch}")];
        if remote == "origin" && branch == "main" {
            names.push("refs/remotes/origin/master".into());
            names.push("refs/remotes/origin/HEAD".into());
        }
        for name in names {
            if let Some(mut r) = self.repo.try_find_reference(name.as_str())? {
                if let Ok(id) = r.follow_to_object() {
                    return Ok(Some(to_hex(id.detach())));
                }
            }
        }
        Ok(None)
    }

    fn head_oid(&self) -> Result<Option<Oid>> {
        let branch = self.current_branch()?;
        Ok(self
            .repo
            .try_find_reference(format!("refs/heads/{branch}").as_str())?
            .and_then(|r| ref_target_oid(&r).map(to_hex)))
    }

    fn fetch(&self, creds: Option<&Credentials>) -> Result<Option<Oid>> {
        let primary = self.primary_remote()?;
        self.fetch_from(&primary, creds)
    }

    fn fetch_from(&self, remote: &str, creds: Option<&Credentials>) -> Result<Option<Oid>> {
        let r = self.repo.find_remote(remote)?;
        // Without explicit credentials, consult git's own credential helpers
        // (e.g. the libsecret keychain) before giving up — this is what makes
        // sync avoid the credentials dialog when a token is already stored
        // locally for this remote.
        let creds = self.resolve_credentials(creds, remote)?;
        let mut con = r.connect(Direction::Fetch)?;
        // Android: reqwest's rustls platform-verifier cannot run inside a
        // Tauri app (no Gradle/JNI bridge), so give the transport options that
        // build the HTTP client from the on-device PEM trust store instead.
        // Without this every HTTPS fetch dies in the TLS handshake.
        #[cfg(target_os = "android")]
        con.set_transport_options(
            android_tls::options().context("prepare Android HTTP transport options")?,
        );
        match creds {
            Some(c) => {
                let account = gix::sec::identity::Account {
                    username: c.username.clone(),
                    password: c.password.clone(),
                    oauth_refresh_token: None,
                };
                con.set_credentials(move |_action| {
                    Ok(Some(gix::credentials::protocol::Outcome {
                        identity: account.clone(),
                        next: gix::credentials::helper::NextAction::from(
                            gix::credentials::protocol::Context::default(),
                        ),
                    }))
                });
            }
            None => {
                con.set_credentials(|_action| {
                    Err(gix::Error::from_error(crate::git_backend::AuthRequired))
                });
            }
        }
        let prep = con
            .prepare_fetch(gix::progress::Discard, Default::default())
            .map_err(|e| anyhow!("prepare_fetch failed: {e}"))?;
        prep.receive(gix::progress::Discard, &gix::interrupt::IS_INTERRUPTED)
            .map_err(|e| anyhow!("fetch receive failed: {e}"))?;
        let branch = self.current_branch()?;
        self.remote_branch_oid_at(remote, &branch)
    }

    fn push_current(&self, expected_local: &Oid, creds: Option<&Credentials>) -> Result<()> {
        let primary = self.primary_remote()?;
        self.push_refspec(&primary, expected_local, creds, false)
    }

    fn push_to(
        &self,
        remote: &str,
        expected_local: &Oid,
        creds: Option<&Credentials>,
    ) -> Result<()> {
        self.push_refspec(remote, expected_local, creds, false)
    }

    fn force_push_current(&self, expected_local: &Oid, creds: Option<&Credentials>) -> Result<()> {
        let primary = self.primary_remote()?;
        self.push_refspec(&primary, expected_local, creds, true)
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

    fn commit_info(&self, commit: &Oid) -> Result<CommitMeta> {
        let obj = self.repo.find_object(from_hex(commit)?)?;
        let c = obj.try_into_commit()?;
        let author = c.author()?;
        Ok(CommitMeta {
            oid: commit.clone(),
            message: String::from_utf8_lossy(c.message_raw()?).to_string(),
            author: author.name.to_str_lossy().to_string(),
            time: c.time()?.seconds,
        })
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
                    TreeEntry {
                        oid: to_hex(entry.inner.oid.to_owned()),
                        is_dir: false,
                    },
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
                .map(from_hex)
                .collect::<Result<Vec<_>>>()?
                .into(),
            extra_headers: Default::default(),
        };
        Ok(to_hex(self.repo.write_object(&commit)?.detach()))
    }

    fn update_branch(&self, commit: &Oid) -> Result<()> {
        let branch = self.current_branch()?;
        let edit = gix::refs::transaction::RefEdit::update(
            format!("refs/heads/{branch}").try_into()?,
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

    fn list_worktree_files(&self) -> Result<Vec<String>> {
        let workdir = self
            .repo
            .workdir()
            .ok_or_else(|| anyhow!("requires a worktree repository"))?
            .to_path_buf();
        let repo = git2::Repository::open(&workdir)?;
        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(true)
            .include_unmodified(true)
            .include_ignored(false)
            .recurse_untracked_dirs(true);
        let statuses = repo.statuses(Some(&mut opts))?;
        let mut files = Vec::new();
        for entry in statuses.iter() {
            let Ok(rel) = entry.path() else { continue };
            let name = rel.rsplit('/').next().unwrap_or(rel);
            if name == "index.db" || name.starts_with("index.db-") {
                continue;
            }
            if workdir.join(rel).is_file() {
                files.push(rel.to_string());
            }
        }
        files.sort();
        Ok(files)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A self-contained fake credential helper: consumes stdin, then answers
    /// any `get` with a fixed username/password pair. Lets us test the
    /// git-helper fallback hermetically, without any real keyring.
    fn fake_helper(dir: &Path) -> PathBuf {
        let helper = dir.join("fake-credential-helper");
        std::fs::write(
            &helper,
            "#!/bin/sh\ncat >/dev/null\nprintf 'username=helper-user\\npassword=helper-pass\\n'\n",
        )
        .expect("write helper script");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&helper).expect("stat").permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&helper, perms).expect("make helper executable");
        }
        helper
    }

    /// A backend whose repo-local git config points `credential.helper` at a
    /// fake helper script and whose `origin` is an https remote — mirroring a
    /// real setup where a token is stored in a local credential store.
    fn backend_with_fake_helper(dir: &Path) -> GixBackend {
        let mut backend = GixBackend::init(dir).expect("init backend");
        backend
            .set_remote("origin", "https://github.com/example/repo.git")
            .expect("set https remote");
        let helper = fake_helper(dir);
        let config_path = dir.join(".git/config");
        let mut file = backend
            .repo
            .config_file_mut(&config_path)
            .expect("open config");
        file.set_raw_value_by(
            "credential",
            None,
            "helper",
            helper.to_string_lossy().as_bytes().as_bstr(),
        )
        .expect("set credential.helper");
        file.commit().expect("commit config");
        backend
    }

    #[test]
    fn falls_back_to_git_credential_helper_for_https() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backend = backend_with_fake_helper(dir.path());

        let creds = backend
            .resolve_credentials(None, "origin")
            .expect("resolve helper credentials")
            .expect("helper must supply credentials");

        assert_eq!(creds.username, "helper-user");
        assert_eq!(creds.password, "helper-pass");
    }

    #[test]
    fn explicit_credentials_win_over_helper() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backend = backend_with_fake_helper(dir.path());
        let supplied = Credentials {
            username: "typed-user".into(),
            password: "typed-pass".into(),
        };

        let creds = backend
            .resolve_credentials(Some(&supplied), "origin")
            .expect("resolve explicit credentials");

        assert!(matches!(
            creds,
            Some(c) if c.username == "typed-user" && c.password == "typed-pass"
        ));
    }

    #[test]
    fn helper_is_not_queried_for_local_remotes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut backend = GixBackend::init(dir.path()).expect("init backend");
        let remote = tempfile::tempdir().expect("remote tempdir");
        let remote_url = remote.path().join("remote.git");
        backend
            .set_remote("origin", &remote_url.to_string_lossy())
            .expect("set local remote");

        assert!(
            backend
                .resolve_credentials(None, "origin")
                .expect("resolve")
                .is_none(),
            "non-https remotes must not trigger the credential helper"
        );
    }
}

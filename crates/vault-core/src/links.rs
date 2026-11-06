//! Broken internal link report: scan the visible notes for `[[wikilinks]]`
//! and relative Markdown links, resolve them against the actual note set,
//! and report every unresolved reference with its source.
//!
//! Resolution mirrors the UI's link dialect (aliases, `#fragments`, percent
//! encoding, source-relative candidates, suffix and title matches) and adds
//! lexical `..`/`.` normalization, so a link that a rename or nested folder
//! move can still resolve does not get reported. Exclusions are an app-view
//! filter here too: excluded notes are neither scanned as sources nor
//! accepted as targets — a link pointing into an excluded folder is broken.

use anyhow::Result;
use std::collections::{BTreeMap, BTreeSet};

use crate::vault::Vault;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    Wiki,
    Markdown,
}

impl LinkKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            LinkKind::Wiki => "wiki",
            LinkKind::Markdown => "markdown",
        }
    }
}

/// One unresolved reference: where it is (`source` + `line`), what it points
/// at (`target`), and the original link text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkRef {
    pub source: String,
    pub target: String,
    pub line: usize,
    pub kind: LinkKind,
    pub text: String,
}

/// The visible `.md` note set, as path set + title (stem) index.
struct Notes {
    paths: BTreeSet<String>,
    /// File stem (basename without `.md`) → full path. Ties keep the
    /// lexicographically first path, matching the UI's shortest-unique
    /// behavior deterministically.
    titles: BTreeMap<String, String>,
}

impl Notes {
    fn scan(vault: &Vault) -> Result<Self> {
        let mut paths = BTreeSet::new();
        let mut titles = BTreeMap::new();
        for (rel, _) in vault.visible_files()? {
            if !rel.ends_with(".md") {
                continue;
            }
            paths.insert(rel.clone());
            let stem = rel
                .rsplit('/')
                .next()
                .unwrap_or(&rel)
                .trim_end_matches(".md");
            titles
                .entry(stem.to_string())
                .or_insert_with(|| rel.clone());
        }
        Ok(Self { paths, titles })
    }

    fn contains(&self, path: &str) -> bool {
        self.paths.contains(path)
    }

    /// Longest suffix (`/rest`) match, unique only — the UI's rule.
    fn unique_suffix(&self, candidate: &str) -> Option<&String> {
        let needle = format!("/{candidate}");
        let mut hits = self
            .paths
            .iter()
            .filter(|p| p.as_str() == candidate || p.ends_with(&needle));
        let first = hits.next()?;
        if hits.next().is_some() {
            return None;
        }
        Some(first)
    }
}

/// Resolve every link in the visible notes; returns only the broken ones,
/// ordered by (source, line, target) for deterministic reports.
pub fn broken_links(vault: &Vault) -> Result<Vec<LinkRef>> {
    let notes = Notes::scan(vault)?;
    let mut broken = Vec::new();
    for (rel, path) in vault.visible_files()? {
        if !rel.ends_with(".md") {
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            // Vanished mid-scan (external edit): nothing to report for it.
            Err(_) => continue,
        };
        for (idx, line) in content.lines().enumerate() {
            for (target, kind, text) in extract(line) {
                if !resolves(&target, &rel, &notes) {
                    broken.push(LinkRef {
                        source: rel.clone(),
                        target,
                        line: idx + 1,
                        kind,
                        text,
                    });
                }
            }
        }
    }
    broken.sort_by(|a, b| (&a.source, a.line, &a.target).cmp(&(&b.source, b.line, &b.target)));
    Ok(broken)
}

/// Does `target` resolve to a visible note, from the note at `source`?
fn resolves(target: &str, source: &str, notes: &Notes) -> bool {
    // Same dialect as the UI preview: strip alias/fragment, percent-decode.
    let mut t = target.to_string();
    if let Ok(decoded) = percent_decode(&t) {
        t = decoded;
    }
    let t = t
        .split('|')
        .next()
        .unwrap_or("")
        .split('#')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if t.is_empty() {
        // `[]()` and `[[#heading]]` are not resolvable references.
        return true;
    }
    let with_ext = if t.ends_with(".md") {
        t.clone()
    } else {
        format!("{t}.md")
    };
    let base = source.split('/').collect::<Vec<_>>();
    let base = &base[..base.len() - 1];
    let prefix = if base.is_empty() {
        String::new()
    } else {
        format!("{}/", base.join("/"))
    };
    let mut candidates = vec![t.clone(), with_ext.clone()];
    if !prefix.is_empty() {
        candidates.push(format!("{prefix}{t}"));
        candidates.push(format!("{prefix}{with_ext}"));
    }
    // Lexical `..`/`.` normalization on the source-relative candidates.
    let normalized = normalize(&format!("{prefix}{with_ext}"));
    if normalized != format!("{prefix}{with_ext}") {
        candidates.push(normalized);
        let t_norm = normalize(&format!("{prefix}{t}"));
        if t_norm != format!("{prefix}{t}") {
            candidates.push(t_norm);
        }
    }
    candidates.iter().any(|c| notes.contains(c))
        || candidates.iter().any(|c| notes.unique_suffix(c).is_some())
        || notes.titles.contains_key(t.trim_end_matches(".md"))
}

/// `a/b/../c.md` → `a/c.md`; `./x` → `x`. Purely lexical.
fn normalize(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    out.join("/")
}

/// Minimal percent-decoding (%XX → byte); invalid escapes stay as-is, and
/// only a result that isn't valid UTF-8 is an error.
fn percent_decode(s: &str) -> Result<String, ()> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let Some(hex) = bytes.get(i + 1..i + 3) {
                if let (Some(hi), Some(lo)) =
                    ((hex[0] as char).to_digit(16), (hex[1] as char).to_digit(16))
                {
                    out.push((hi * 16 + lo) as u8);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).map_err(|_| ())
}

/// Extract link targets from one source line: wikilinks first, then
/// Markdown links. Markdown targets pointing at non-notes (images, web
/// URLs, plain anchors) are skipped — the report is about note links.
fn extract(line: &str) -> Vec<(String, LinkKind, String)> {
    let mut out = Vec::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'[' && bytes.get(i + 1) == Some(&b'[') {
            if let Some(end) = line[i + 2..].find("]]") {
                let inner = &line[i + 2..i + 2 + end];
                if !inner.contains('[') {
                    // Dialect: [[target]], [[target|alias]], [[target#frag]].
                    let (target_part, alias) = match inner.split_once('|') {
                        Some((t, a)) => (t, Some(a)),
                        None => (inner, None),
                    };
                    let target = target_part
                        .split('#')
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if !target.is_empty() {
                        let text = alias.map(str::to_string).unwrap_or_else(|| target.clone());
                        out.push((target, LinkKind::Wiki, text));
                    }
                    i += 2 + end + 2;
                    continue;
                }
            }
        }
        // Markdown: [text](target) — the `](` must be balanced on the line.
        if bytes[i] == b']' && bytes.get(i + 1) == Some(&b'(') {
            if let Some(end) = line[i + 2..].find(')') {
                let raw = &line[i + 2..i + 2 + end];
                let text_start = line[..i].rfind('[').map(|p| p + 1).unwrap_or(i);
                let text = &line[text_start..i];
                if let Some(target) = note_markdown_target(raw) {
                    out.push((target, LinkKind::Markdown, text.to_string()));
                }
                i += 2 + end + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Keep only internal note targets: no URLs, no pure anchors, no images.
fn note_markdown_target(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty()
        || t.starts_with("http://")
        || t.starts_with("https://")
        || t.starts_with("mailto:")
        || t.starts_with('#')
        || t.starts_with("wiki:")
    {
        return None;
    }
    // Fragment-only after stripping means an in-note heading link.
    let stripped = t.split('#').next().unwrap_or("").trim().to_string();
    if stripped.is_empty() {
        return None;
    }
    // Note links end in .md or carry no extension at all ("./foo", "foo").
    let last = stripped.rsplit('/').next().unwrap_or(&stripped);
    if last.contains('.') && !stripped.ends_with(".md") {
        return None;
    }
    Some(stripped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_wikilinks_with_aliases_and_fragments() {
        let line = "See [[Target]] and [[Other|the alias]] plus [[Book#chapter]].";
        let links = extract(line);
        assert_eq!(
            links,
            vec![
                ("Target".to_string(), LinkKind::Wiki, "Target".to_string()),
                ("Other".to_string(), LinkKind::Wiki, "the alias".to_string()),
                ("Book".to_string(), LinkKind::Wiki, "Book".to_string()),
            ]
        );
    }

    #[test]
    fn skips_non_note_markdown_targets() {
        assert_eq!(note_markdown_target("https://example.com"), None);
        assert_eq!(note_markdown_target("#heading"), None);
        assert_eq!(note_markdown_target("image.png"), None);
        assert_eq!(note_markdown_target("img.png#x"), None);
        assert_eq!(
            note_markdown_target("notes/foo.md#sec"),
            Some("notes/foo.md".to_string())
        );
        assert_eq!(note_markdown_target("./bar"), Some("./bar".to_string()));
        assert_eq!(
            note_markdown_target("my%20note.md"),
            Some("my%20note.md".to_string())
        );
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("a%20b"), Ok("a b".to_string()));
        assert_eq!(percent_decode("%zz"), Ok("%zz".to_string()));
        assert_eq!(percent_decode("plain"), Ok("plain".to_string()));
    }

    #[test]
    fn normalization_walks_up() {
        assert_eq!(normalize("a/b/../c.md"), "a/c.md");
        assert_eq!(normalize("./x/y.md"), "x/y.md");
        assert_eq!(normalize("a/../../b.md"), "b.md");
    }
}

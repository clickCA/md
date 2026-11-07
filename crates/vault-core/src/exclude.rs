//! Per-vault path exclusions: `.quireignore` at the vault root.
//!
//! Exclusions are an **app-view** filter, deliberately separate from
//! `.gitignore`: matching notes stay on disk, tracked by git, and synced —
//! they are only hidden from the app's own surfaces (file tree, note
//! listing, search, and the AI features built on them). The same list also
//! drives **selective sync** (see `Vault::filter_sync_tree`): with the
//! device-local toggle off — the default — excluded paths are never staged,
//! committed, pushed, merged, or checked out by the sync machinery; the
//! toggle forces a full sync. Git's own semantics are untouched either way:
//! excluded notes stay on disk, and anything already in history remains.
//!
//! Syntax follows `.gitignore` habits users already know, scoped down to
//! what a note vault needs — each rule parsed from one line:
//!
//! - blank lines and `# comments` are skipped
//! - `!pattern` re-includes (negation); **the last matching rule wins**
//! - a trailing `/` marks a directory-only rule (`build/` hides everything
//!   under any `build` directory but never a *file* named `build`)
//! - a pattern containing `/` is anchored to the vault root (`docs/drafts`);
//!   otherwise it matches at any depth (`*.log`, `scratch`)
//! - `*` matches within one path segment, `?` one character, and a whole
//!   segment `**` matches zero or more segments (`**/temp`, `a/**/b`)
//! - a rule that matches a directory hides everything below it

/// The per-vault exclusion file, at the vault root.
pub const IGNORE_FILE: &str = ".quireignore";

#[derive(Debug, Clone, PartialEq, Eq)]
struct Rule {
    negated: bool,
    dir_only: bool,
    anchored: bool,
    pattern: Vec<String>,
}

/// Parsed exclusion rule set. Load fresh per operation — the file is tiny
/// and external edits must apply immediately (same stance as search drift).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Exclusions {
    rules: Vec<Rule>,
}

impl Exclusions {
    /// Parse the rule text (one rule per line, `.gitignore` habits).
    pub fn parse(text: &str) -> Self {
        let mut rules = Vec::new();
        for line in text.lines() {
            let line = line.trim_end();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (negated, rest) = match line.strip_prefix('!') {
                Some(rest) => (true, rest),
                None => (false, line),
            };
            if rest.is_empty() {
                continue;
            }
            let (dir_only, rest) = match rest.strip_suffix('/') {
                Some(rest) => (true, rest),
                None => (false, rest),
            };
            // A slash anywhere (including a leading one) anchors the rule to
            // the vault root; the leading slash itself is not part of the
            // pattern.
            let anchored = rest.contains('/');
            let rest = rest.strip_prefix('/').unwrap_or(rest);
            let pattern: Vec<String> = rest
                .split('/')
                .filter(|seg| !seg.is_empty())
                .map(str::to_string)
                .collect();
            if pattern.is_empty() {
                continue;
            }
            rules.push(Rule {
                negated,
                dir_only,
                anchored,
                pattern,
            });
        }
        Self { rules }
    }

    /// Load `<vault root>/.quireignore`; a missing file excludes nothing.
    pub fn load(root: &std::path::Path) -> Self {
        let text = std::fs::read_to_string(root.join(IGNORE_FILE)).unwrap_or_default();
        Self::parse(&text)
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// Does this vault-relative path (forward slashes) match the rules?
    /// The last matching rule wins, so `!` re-inclusion works in the order
    /// the rules appear in the file.
    pub fn is_excluded(&self, rel: &str) -> bool {
        let segs: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
        let mut excluded = false;
        for rule in &self.rules {
            if rule_matches(rule, &segs) {
                excluded = !rule.negated;
            }
        }
        excluded
    }
}

/// Does this rule match the path? A rule matches when its pattern matches
/// the whole path (the file itself) or a proper ancestor directory
/// (everything under a matching directory is hidden). Directory-only rules
/// never match a file directly — only ancestors.
fn rule_matches(rule: &Rule, segs: &[&str]) -> bool {
    if rule.pattern.is_empty() || segs.is_empty() {
        return false;
    }
    let mut starts: Box<dyn Iterator<Item = usize>> = if rule.anchored {
        Box::new(std::iter::once(0))
    } else {
        Box::new(0..segs.len())
    };
    starts.any(|s| match_from(&rule.pattern, &segs[s..], rule.dir_only))
}

/// Match pattern segments against a *prefix* of `path`: a full-segment
/// pattern match that leaves any remainder means "this directory and
/// everything below it". Directory-only rules require such a remainder
/// (a file path is never itself a directory).
fn match_from(pat: &[String], path: &[&str], dir_only: bool) -> bool {
    match pat.first() {
        None => {
            if dir_only {
                !path.is_empty()
            } else {
                true
            }
        }
        Some(seg) if seg == "**" => {
            (0..=path.len()).any(|k| match_from(&pat[1..], &path[k..], dir_only))
        }
        Some(seg) => {
            !path.is_empty()
                && glob_match(seg, path[0])
                && match_from(&pat[1..], &path[1..], dir_only)
        }
    }
}

/// Classic single-segment glob: `*` any run, `?` exactly one char.
fn glob_match(pat: &str, text: &str) -> bool {
    let p: Vec<char> = pat.chars().collect();
    let t: Vec<char> = text.chars().collect();
    fn rec(p: &[char], t: &[char]) -> bool {
        if p.is_empty() {
            return t.is_empty();
        }
        match p[0] {
            '*' => {
                let mut i = 1;
                while i < p.len() && p[i] == '*' {
                    i += 1;
                }
                (0..=t.len()).any(|k| rec(&p[i..], &t[k..]))
            }
            '?' => !t.is_empty() && rec(&p[1..], &t[1..]),
            c => !t.is_empty() && t[0] == c && rec(&p[1..], &t[1..]),
        }
    }
    rec(&p, &t)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ex(text: &str) -> Exclusions {
        Exclusions::parse(text)
    }

    #[test]
    fn empty_and_missing_mean_no_exclusions() {
        assert!(ex("").is_empty());
        assert!(ex("# only a comment\n\n").is_empty());
        assert!(!ex("").is_excluded("anything/at/all.md"));
    }

    #[test]
    fn comments_and_blank_lines_are_skipped() {
        let rules = ex("# header\n\nprivate/\n  \n*.log\n").rules;
        assert_eq!(rules.len(), 2, "comments/blanks dropped: {rules:?}");
    }

    #[test]
    fn unanchored_name_matches_at_any_depth() {
        let rules = ex("scratch\n");
        assert!(rules.is_excluded("scratch"), "the file itself");
        assert!(rules.is_excluded("a/b/scratch/note.md"), "dir contents");
        assert!(rules.is_excluded("scratch/deep/note.md"), "dir contents");
        assert!(
            !rules.is_excluded("scratch.md"),
            "exact segment, not prefix"
        );
        assert!(!rules.is_excluded("notes/scratchpad.md"));
    }

    #[test]
    fn directory_rule_hides_contents_but_not_a_file_of_that_name() {
        let rules = ex("build/\n");
        assert!(rules.is_excluded("build/out.md"));
        assert!(rules.is_excluded("a/build/out.md"));
        assert!(!rules.is_excluded("build"), "a *file* named build");
    }

    #[test]
    fn anchored_rule_needs_the_prefix() {
        let rules = ex("docs/drafts\n");
        assert!(rules.is_excluded("docs/drafts/x.md"));
        assert!(!rules.is_excluded("other/docs/drafts/x.md"));
        assert!(!rules.is_excluded("docs/x.md"));
    }

    #[test]
    fn leading_slash_anchors() {
        let rules = ex("/top.md\n");
        assert!(rules.is_excluded("top.md"));
        assert!(!rules.is_excluded("a/top.md"));
    }

    #[test]
    fn glob_star_matches_within_a_segment() {
        let rules = ex("*.log\ndraft-?.md\n");
        assert!(rules.is_excluded("a/b/debug.log"));
        assert!(!rules.is_excluded("debug.logx"));
        assert!(rules.is_excluded("draft-1.md"));
        assert!(rules.is_excluded("draft-x.md"));
        assert!(!rules.is_excluded("draft-12.md"));
    }

    #[test]
    fn double_star_spans_segments() {
        let rules = ex("**/temp\na/**/b.md\n");
        assert!(rules.is_excluded("temp"));
        assert!(rules.is_excluded("deep/nest/temp"));
        assert!(rules.is_excluded("a/b.md"), "** matches zero segments");
        assert!(rules.is_excluded("a/x/y/b.md"));
        assert!(!rules.is_excluded("b/a/x.md"));
    }

    #[test]
    fn negation_re_includes_last_match_wins() {
        let rules = ex("*.md\n!important.md\nprivate/\n!private/shared/\n");
        assert!(rules.is_excluded("note.md"));
        assert!(!rules.is_excluded("important.md"));
        assert!(rules.is_excluded("private/secret.md"));
        assert!(!rules.is_excluded("private/shared/x.md"));
    }

    #[test]
    fn sibling_rules_do_not_interfere() {
        let rules = ex("a\nab\n");
        assert!(rules.is_excluded("a/x.md"));
        assert!(rules.is_excluded("ab/x.md"));
    }

    #[test]
    fn load_reads_the_vault_file() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(IGNORE_FILE), "hidden/\n").unwrap();
        let loaded = Exclusions::load(tmp.path());
        assert!(loaded.is_excluded("hidden/note.md"));
        assert!(!loaded.is_excluded("note.md"));
        let missing = Exclusions::load(&tmp.path().join("nowhere"));
        assert!(missing.is_empty());
    }
}

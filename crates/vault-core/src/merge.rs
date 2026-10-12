use imara_diff::{Algorithm, Diff, InternedInput};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub struct Hunk {
    pub base_start: usize,
    pub base_end: usize,
    pub other_start: usize,
    pub other_end: usize,
}

fn split_lines(data: &[u8]) -> Vec<&[u8]> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (i, &b) in data.iter().enumerate() {
        if b == b'\n' {
            lines.push(&data[start..=i]);
            start = i + 1;
        }
    }
    if start < data.len() {
        lines.push(&data[start..]);
    }
    lines
}

fn join_lines(lines: &[&[u8]]) -> Vec<u8> {
    lines.iter().flat_map(|l| l.iter().copied()).collect()
}

fn hunks(base: &[u8], other: &[u8]) -> Vec<Hunk> {
    let input: InternedInput<&[u8]> = InternedInput::new(base, other);
    let mut diff = Diff::compute(Algorithm::Myers, &input);
    diff.postprocess_lines(&input);
    diff.hunks()
        .map(|h| Hunk {
            base_start: h.before.start as usize,
            base_end: h.before.end as usize,
            other_start: h.after.start as usize,
            other_end: h.after.end as usize,
        })
        .collect()
}

fn overlaps(a: &Hunk, b: &Hunk) -> bool {
    let a_hi = if a.base_end == a.base_start { a.base_start + 1 } else { a.base_end };
    let b_hi = if b.base_end == b.base_start { b.base_start + 1 } else { b.base_end };
    a.base_start < b_hi && b.base_start < a_hi
}

fn side_text(base: &[&[u8]], other: &[&[u8]], side: &[&Hunk], gs: usize, ge: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut p = gs;
    for h in side {
        if h.base_start > p {
            out.extend_from_slice(&join_lines(&base[p..h.base_start]));
        }
        out.extend_from_slice(&join_lines(&other[h.other_start..h.other_end]));
        p = p.max(h.base_end);
    }
    if p < ge {
        out.extend_from_slice(&join_lines(&base[p..ge]));
    }
    out
}

pub fn try_line_merge(base: &[u8], ours: &[u8], theirs: &[u8]) -> Option<Vec<u8>> {
    let base_l = split_lines(base);
    let ours_l = split_lines(ours);
    let theirs_l = split_lines(theirs);
    let oh = hunks(base, ours);
    let th = hunks(base, theirs);
    if oh.is_empty() || th.is_empty() {
        return if oh.is_empty() { Some(theirs.to_vec()) } else { Some(ours.to_vec()) };
    }
    let mut events: Vec<(usize, bool, usize)> = oh
        .iter()
        .enumerate()
        .map(|(i, h)| (h.base_start, true, i))
        .chain(th.iter().enumerate().map(|(i, h)| (h.base_start, false, i)))
        .collect();
    events.sort();
    let mut out = Vec::new();
    let mut p = 0;
    let mut ei = 0;
    let mut used = vec![false; events.len()];
    while ei < events.len() {
        let (_, side, idx) = events[ei];
        let first = if side { &oh[idx] } else { &th[idx] };
        let mut group = first.clone();
        let mut group_ours: Vec<&Hunk> = Vec::new();
        let mut group_theirs: Vec<&Hunk> = Vec::new();
        if side {
            group_ours.push(first);
        } else {
            group_theirs.push(first);
        }
        used[ei] = true;
        let mut grew = true;
        while grew {
            grew = false;
            for j in 0..events.len() {
                if used[j] {
                    continue;
                }
                let (_, s, i) = events[j];
                let h = if s { &oh[i] } else { &th[i] };
                let group_h = Hunk {
                    base_start: group.base_start,
                    base_end: group.base_end,
                    other_start: 0,
                    other_end: 0,
                };
                if overlaps(&group_h, h) {
                    if s {
                        group_ours.push(h);
                    } else {
                        group_theirs.push(h);
                    }
                    group.base_start = group.base_start.min(h.base_start);
                    group.base_end = group.base_end.max(h.base_end);
                    used[j] = true;
                    grew = true;
                }
            }
        }
        if p < group.base_start {
            out.extend_from_slice(&join_lines(&base_l[p..group.base_start]));
        }
        let gs = group.base_start;
        let ge = group.base_end;
        let o_text = if group_ours.is_empty() {
            join_lines(&base_l[gs.min(base_l.len())..ge.min(base_l.len())])
        } else {
            side_text(&base_l, &ours_l, &group_ours, gs, ge)
        };
        let t_text = if group_theirs.is_empty() {
            join_lines(&base_l[gs.min(base_l.len())..ge.min(base_l.len())])
        } else {
            side_text(&base_l, &theirs_l, &group_theirs, gs, ge)
        };
        if group_ours.is_empty() {
            out.extend_from_slice(&t_text);
        } else if group_theirs.is_empty() {
            out.extend_from_slice(&o_text);
        } else if o_text == t_text {
            out.extend_from_slice(&o_text);
        } else {
            return None;
        }
        p = ge;
        while ei < events.len() && used[ei] {
            ei += 1;
        }
    }
    if p < base_l.len() {
        out.extend_from_slice(&join_lines(&base_l[p..]));
    }
    Some(out)
}

pub fn flatten_blobs(
    tree: &BTreeMap<String, crate::git_backend::TreeEntry>,
) -> BTreeMap<String, String> {
    tree.iter()
        .filter(|(_, e)| !e.is_dir)
        .map(|(p, e)| (p.clone(), e.oid.clone()))
        .collect()
}

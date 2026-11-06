//! Coding-agent integration: spawn the opencode / codex / Claude Code CLIs
//! against the vault directory and stream their output into the UI.
//!
//! These CLIs are treated as black boxes (FND-12: the command layer is the
//! only boundary). Quire never holds API keys: each agent reads its own
//! auth from the user's HOME, exactly as it would from a terminal. The
//! working directory is always the vault root, so whatever the agent edits —
//! notes or code living in the vault — is captured by the existing git
//! review/sync flow downstream.
//!
//! Runs are one-shot, non-interactive invocations (`opencode run` /
//! `codex exec` / `claude -p`), streamed to the caller over a Tauri
//! [`Channel`]. Cancellation kills the child and marks the run cancelled.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::State;
use tauri::ipc::Channel;

use super::blocking;
use crate::error::AppError;

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentProvider {
    Opencode,
    Codex,
    Claude,
}

impl AgentProvider {
    pub const ALL: [AgentProvider; 3] = [
        AgentProvider::Opencode,
        AgentProvider::Codex,
        AgentProvider::Claude,
    ];

    pub fn id(self) -> &'static str {
        match self {
            AgentProvider::Opencode => "opencode",
            AgentProvider::Codex => "codex",
            AgentProvider::Claude => "claude",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            AgentProvider::Opencode => "opencode",
            AgentProvider::Codex => "codex",
            AgentProvider::Claude => "Claude Code",
        }
    }

    /// The binary that must be on PATH for this provider to be usable.
    pub fn binary(self) -> &'static str {
        self.id()
    }

    /// Where the CLI itself documents auth (shown in the UI when absent).
    pub fn install_hint(self) -> &'static str {
        match self {
            AgentProvider::Opencode => "npm i -g opencode-ai (then run `opencode` once to sign in)",
            AgentProvider::Codex => "install the codex CLI and run `codex login`",
            AgentProvider::Claude => {
                "npm i -g @anthropic-ai/claude-code (then run `claude` once to authenticate)"
            }
        }
    }
}

pub fn parse_provider(s: &str) -> Option<AgentProvider> {
    match s.trim().to_ascii_lowercase().as_str() {
        "opencode" => Some(AgentProvider::Opencode),
        "codex" => Some(AgentProvider::Codex),
        "claude" | "claude-code" | "claude-code-cli" => Some(AgentProvider::Claude),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Command construction
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct AgentRunOptions {
    /// Let the agent apply file edits / run commands without prompting.
    pub auto_approve: bool,
    /// Continue the provider's most recent session in this directory.
    pub continue_session: bool,
    /// Resume a precise earlier session (provider-specific id).
    pub resume_session_id: Option<String>,
}

/// Everything needed to spawn one run; bundled so the runner stays under
/// clippy's argument ceiling and the test harness can fake an executable.
struct AgentInvocation {
    provider: AgentProvider,
    binary: PathBuf,
    args: Vec<String>,
    dir: PathBuf,
}

/// Claude's terminal metadata captured from the `result` event:
/// `(session_id, human summary)`.
type ClaudeResult = Option<(Option<String>, Option<String>)>;

/// Build the non-interactive argv for a provider. The prompt is the final
/// positional argument; every flag Quire adds is listed here for tests.
pub fn build_args(provider: AgentProvider, prompt: &str, opts: &AgentRunOptions) -> Vec<String> {
    let mut args: Vec<String> = provider_base_args(provider)
        .iter()
        .map(|s| s.to_string())
        .collect();

    if let Some(id) = opts.resume_session_id.as_deref().filter(|s| !s.is_empty()) {
        match provider {
            AgentProvider::Claude => {
                args.push("--resume".into());
                args.push(id.to_string());
            }
            AgentProvider::Opencode => {
                args.push("--session".into());
                args.push(id.to_string());
            }
            // codex exec exposes no resume-by-id in a stable flag; continuing
            // the most recent session is the closest portable behaviour.
            AgentProvider::Codex => args.push("--continue".into()),
        }
    } else if opts.continue_session {
        match provider {
            AgentProvider::Claude | AgentProvider::Opencode | AgentProvider::Codex => {
                args.push("--continue".into());
            }
        }
    }

    if opts.auto_approve {
        match provider {
            AgentProvider::Claude => {
                args.push("--permission-mode".into());
                args.push("bypassPermissions".into());
            }
            AgentProvider::Opencode => args.push("--auto".into()),
            AgentProvider::Codex => args.push("--full-auto".into()),
        }
    } else if provider == AgentProvider::Claude {
        // Without auto-approve, Claude Code may still edit existing files
        // while never blocking on a prompt (a non-interactive `-p` run cannot
        // ask; anything else is auto-denied). Bash/git stay disabled.
        args.push("--permission-mode".into());
        args.push("acceptEdits".into());
    }

    match provider {
        AgentProvider::Claude => {
            // stream-json emits one JSON event per line to stdout, so the UI
            // gets tokens as they arrive instead of one blob at the end.
            args.push("--output-format".into());
            args.push("stream-json".into());
            args.push("--include-partial-messages".into());
        }
        AgentProvider::Opencode | AgentProvider::Codex => {}
    }

    args.push(prompt.trim().to_string());
    args
}

fn provider_base_args(provider: AgentProvider) -> &'static [&'static str] {
    match provider {
        AgentProvider::Opencode => &["run"],
        AgentProvider::Codex => &["exec"],
        AgentProvider::Claude => &["-p"],
    }
}

// ---------------------------------------------------------------------------
// Binary discovery (PATH only — no execution, no side effects)
// ---------------------------------------------------------------------------

/// PATH-style list split on the platform separator (`:` on Unix, `;` on
/// Windows). Empty entries are skipped.
pub fn split_path(path: &str) -> Vec<String> {
    let sep = if cfg!(windows) { ';' } else { ':' };
    path.split(sep)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// Is `bin` (already in the entry, platform name) an executable file present
/// on disk? Windows appends `.exe`/`.cmd`/`.bat`; Unix just checks the entry.
pub fn find_in_path(entries: &[String], bin: &str) -> Option<PathBuf> {
    for entry in entries {
        let p = PathBuf::from(entry).join(bin);
        if p.is_file() {
            return Some(p);
        }
        #[cfg(windows)]
        for ext in ["exe", "cmd", "bat"] {
            let q = PathBuf::from(entry).join(format!("{bin}.{ext}"));
            if q.is_file() {
                return Some(q);
            }
        }
    }
    None
}

pub fn resolve_binary(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let entries = split_path(&path.to_string_lossy());
    find_in_path(&entries, bin)
}

// ---------------------------------------------------------------------------
// Claude Code stream-json normalisation
// ---------------------------------------------------------------------------

/// What a single line of `claude -p --output-format stream-json` means to us.
#[derive(Debug, Clone)]
pub enum ClaudeLine {
    /// Human-readable assistant text (streamed; `partial: true` runs too).
    Text(String),
    /// The terminal `result` event — carries the session id + summary.
    Ended {
        session_id: Option<String>,
        summary: Option<String>,
    },
}

/// Parse one stdout line from Claude Code's `stream-json` output into
/// something the transcript can show. Non-text lines (system init, tool
/// results Claude handled on its own, the `result` event, garbage) return
/// `None`/`Ended` instead of leaking raw JSON into the panel.
pub fn parse_claude_line(line: &str) -> Option<ClaudeLine> {
    let line = line.trim();
    if !line.starts_with('{') || !line.ends_with('}') {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    match v.get("type")?.as_str()? {
        "assistant" => {
            let message = v.get("message")?;
            let content = message.get("content")?;
            let mut out = String::new();
            if let Some(blocks) = content.as_array() {
                for block in blocks {
                    if block.get("type").and_then(|t| t.as_str()) != Some("text") {
                        continue;
                    }
                    if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                        out.push_str(t);
                    } else if let Some(d) = block.get("delta").and_then(|d| d.as_str()) {
                        out.push_str(d);
                    }
                }
            } else if let Some(s) = content.as_str() {
                out.push_str(s);
            }
            if out.is_empty() {
                None
            } else {
                Some(ClaudeLine::Text(out))
            }
        }
        "result" => {
            let session_id = v
                .get("session_id")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let summary = result_summary(&v);
            Some(ClaudeLine::Ended {
                session_id,
                summary,
            })
        }
        _ => None,
    }
}

/// Human summary from the CLI's own counters, e.g.
/// "finished in 12.4s · 3 files modified · +214/−9 lines".
fn result_summary(v: &serde_json::Value) -> Option<String> {
    let files = v.get("total_files_modified").and_then(|n| n.as_u64());
    let added = v
        .get("total_lines_added")
        .and_then(|n| n.as_u64())
        .unwrap_or(0);
    let removed = v
        .get("total_lines_removed")
        .and_then(|n| n.as_u64())
        .unwrap_or(0);
    let is_error = v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false);
    let duration = v.get("duration_ms").and_then(|n| n.as_u64());
    let secs = duration.map(|ms| ms as f64 / 1000.0);

    let mut parts: Vec<String> = Vec::new();
    if is_error {
        parts.push("ended with an error".to_string());
    } else {
        parts.push("finished".to_string());
    }
    if let Some(s) = secs {
        parts.push(format!("in {s:.1}s"));
    }
    if let Some(f) = files {
        parts.push(format!(
            "{f} file{} modified",
            if f == 1 { "" } else { "s" }
        ));
    }
    parts.push(format!(
        "+{added}/−{removed} lines",
        added = added,
        removed = removed
    ));
    Some(parts.join(" · "))
}

// ---------------------------------------------------------------------------
// git status --porcelain parsing (which files did the agent touch?)
// ---------------------------------------------------------------------------

/// Parse `git status --porcelain` output into changed paths (vault-relative).
/// Handles the `XY path` layout, rename `old -> new` targets, and quoted
/// (core.quotePath) paths.
pub fn parse_git_status(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim_end_matches('\r');
            let bytes = line.as_bytes();
            if bytes.len() < 4 || bytes[2] != b' ' {
                return None;
            }
            let rest = &line[3..];
            let target = match rest.find(" -> ") {
                Some(idx) => &rest[idx + 4..],
                None => rest,
            };
            let unquoted = if target.starts_with('"') && target.ends_with('"') && target.len() >= 2
            {
                target[1..target.len() - 1]
                    .replace("\\\"", "\"")
                    .replace("\\\\", "\\")
            } else {
                target.to_string()
            };
            if unquoted.is_empty() {
                None
            } else {
                Some(unquoted)
            }
        })
        .collect()
}

/// Working-tree changes relative to HEAD (or the empty tree for a fresh
/// vault), as vault-relative paths. Anything the agent wrote lands here.
fn changed_files_under(dir: &Path) -> Result<Vec<String>, AppError> {
    let out = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| AppError::Io(format!("git status failed: {e}")))?;
    if !out.status.success() {
        return Err(AppError::Vault(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    Ok(parse_git_status(&String::from_utf8_lossy(&out.stdout)))
}

// ---------------------------------------------------------------------------
// Tauri surface
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderDto {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub install_hint: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentEvent {
    /// One chunk of raw output (a line from the CLI, or a normalized Claude
    /// text event).
    Output { stream: String, text: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunDto {
    pub status: String,
    pub changed_files: Vec<String>,
    pub session_id: Option<String>,
    pub summary: Option<String>,
    pub duration_ms: u64,
}

/// Per-turn options from the UI (see `docs/api.md` for the wire contract).
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunOptionsDto {
    pub auto_approve: bool,
    pub continue_session: bool,
    pub resume_session_id: Option<String>,
}

/// The one active agent run, so `agent_stop` can cancel it. Guard the
/// invariant "at most one run at a time" by constructing under the lock.
#[derive(Default)]
pub struct AgentState {
    active: Mutex<Option<Arc<ActiveRun>>>,
}

struct ActiveRun {
    cancel: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
}

/// List the providers whose CLI is on PATH. Cheap: PATH probe, no execution.
#[tauri::command]
#[tracing::instrument(level = "debug")]
pub async fn agent_detect() -> Vec<AgentProviderDto> {
    AgentProvider::ALL
        .iter()
        .map(|p| AgentProviderDto {
            id: p.id().to_string(),
            label: p.label().to_string(),
            available: resolve_binary(p.binary()).is_some(),
            install_hint: p.install_hint().to_string(),
        })
        .collect()
}

/// Run the agent. Streams `AgentEvent`s over `on_event` as the CLI produces
/// them; resolves once the process exits (or is cancelled via `agent_stop`)
/// with what it changed.
#[tauri::command]
#[tracing::instrument(level = "debug", err, skip(on_event, state))]
pub async fn agent_run(
    dir: String,
    provider: String,
    prompt: String,
    options: AgentRunOptionsDto,
    on_event: Channel<AgentEvent>,
    state: State<'_, AgentState>,
) -> Result<AgentRunDto, AppError> {
    let provider = parse_provider(&provider)
        .ok_or_else(|| AppError::InvalidInput(format!("unknown agent provider: {provider}")))?;
    if prompt.trim().is_empty() {
        return Err(AppError::InvalidInput("prompt is empty".into()));
    }
    let dir_p = PathBuf::from(&dir);
    if !dir_p.is_dir() {
        return Err(AppError::InvalidInput(format!("not a directory: {dir}")));
    }
    let binary = resolve_binary(provider.binary()).ok_or_else(|| {
        AppError::InvalidInput(format!(
            "{} is not on PATH — {}",
            provider.label(),
            provider.install_hint()
        ))
    })?;

    // One run at a time; construct the registration atomically.
    let cancel = Arc::new(AtomicBool::new(false));
    let child = Arc::new(Mutex::new(None::<Child>));
    {
        let mut active = state.active.lock().unwrap();
        if active.is_some() {
            return Err(AppError::Internal(
                "an agent run is already in progress".into(),
            ));
        }
        *active = Some(Arc::new(ActiveRun {
            cancel: cancel.clone(),
            child: child.clone(),
        }));
    }

    let invocation = AgentInvocation {
        provider,
        binary,
        args: build_args(
            provider,
            &prompt,
            &AgentRunOptions {
                auto_approve: options.auto_approve,
                continue_session: options.continue_session,
                resume_session_id: options.resume_session_id,
            },
        ),
        dir: dir_p,
    };

    let result = blocking(move || run_agent_impl(invocation, cancel, child, on_event)).await;

    *state.active.lock().unwrap() = None;
    result
}

/// Stop the in-flight agent run, if any. Kills the child; the run resolves
/// with `status: "cancelled"`.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn agent_stop(state: State<'_, AgentState>) -> Result<(), AppError> {
    let Some(run) = state.active.lock().unwrap().take() else {
        return Ok(());
    };
    run.cancel.store(true, Ordering::SeqCst);
    if let Some(child) = run.child.lock().unwrap().as_mut() {
        let _ = child.kill();
    }
    Ok(())
}

/// The process part of a run — pure enough to exercise with a fake CLI in
/// tests. Spawns, streams both pipes to `on_event`, watches `cancel`, reaps
/// the child, and reports git changes afterwards.
fn run_agent_impl(
    inv: AgentInvocation,
    cancel: Arc<AtomicBool>,
    child_slot: Arc<Mutex<Option<Child>>>,
    on_event: Channel<AgentEvent>,
) -> Result<AgentRunDto, AppError> {
    let start = Instant::now();
    let mut cmd = Command::new(&inv.binary);
    cmd.args(&inv.args)
        .current_dir(&inv.dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Io(format!("failed to start {}: {e}", inv.binary.display())))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    *child_slot.lock().unwrap() = Some(child);

    // Monitor thread: kill on cancel (promptly, from outside the reader
    // threads), and exit on its own once the child is gone.
    let monitor_child = child_slot.clone();
    let monitor_cancel = cancel.clone();
    let monitor_stop = Arc::new(AtomicBool::new(false));
    let monitor_stop2 = monitor_stop.clone();
    thread::spawn(move || {
        loop {
            if monitor_stop2.load(Ordering::SeqCst) {
                return;
            }
            if monitor_cancel.load(Ordering::SeqCst) {
                if let Some(c) = monitor_child.lock().unwrap().as_mut() {
                    let _ = c.kill();
                }
                return;
            }
            let exited = monitor_child
                .lock()
                .unwrap()
                .as_mut()
                .and_then(|c| c.try_wait().ok().flatten())
                .is_some();
            if exited {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
    });

    // Completion signal between the two readers and this thread.
    let (done_tx, done_rx) = std::sync::mpsc::channel::<&'static str>();

    let cli_result: Arc<Mutex<ClaudeResult>> = Arc::default();

    // stdout reader (provider-specific: claude emits JSONL on stdout)
    let provider = inv.provider;
    let emit = on_event.clone();
    let done = done_tx.clone();
    let result_slot = cli_result.clone();
    let stdout_reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let line = line.trim_end_matches('\r').to_string();
            match provider {
                AgentProvider::Claude => match parse_claude_line(&line) {
                    Some(ClaudeLine::Text(t)) => {
                        let _ = emit.send(AgentEvent::Output {
                            stream: "stdout".into(),
                            text: t,
                        });
                    }
                    Some(ClaudeLine::Ended {
                        session_id,
                        summary,
                    }) => {
                        *result_slot.lock().unwrap() = Some((session_id, summary));
                    }
                    None => {}
                },
                AgentProvider::Opencode | AgentProvider::Codex => {
                    let _ = emit.send(AgentEvent::Output {
                        stream: "stdout".into(),
                        text: line,
                    });
                }
            }
        }
        let _ = done.send("stdout");
    });

    // stderr reader (warnings/errors; claude's own lifecycle noise)
    let emit = on_event.clone();
    let done = done_tx.clone();
    let stderr_reader = thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let line = line.trim_end_matches('\r').to_string();
            if !line.trim().is_empty() {
                let _ = emit.send(AgentEvent::Output {
                    stream: "stderr".into(),
                    text: line,
                });
            }
        }
        let _ = done.send("stderr");
    });
    // Drop the sender clones so the channel closes when both readers finish.
    drop(done_tx);

    // Wait for both pipes to close. The 60 s cap is a safe net: if a child
    // hangs with an open pipe and no cancel, force-kill instead of blocking
    // the command forever.
    let _ = done_rx.recv_timeout(Duration::from_secs(60));
    let _ = done_rx.recv_timeout(Duration::from_secs(60));
    monitor_stop.store(true, Ordering::SeqCst);
    if let Some(c) = child_slot.lock().unwrap().as_mut() {
        let _ = c.kill(); // no-op if already exited
    }

    let _ = child_slot
        .lock()
        .unwrap()
        .as_mut()
        .map(|c| c.wait().map(|s| s.code()).ok().flatten());
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();

    let status = if cancel.load(Ordering::SeqCst) {
        "cancelled"
    } else {
        "done"
    }
    .to_string();
    let (session_id, summary) = cli_result.lock().unwrap().clone().unwrap_or((None, None));
    let changed_files = changed_files_under(&inv.dir).unwrap_or_default();

    Ok(AgentRunDto {
        status,
        changed_files,
        session_id,
        summary,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(auto_approve: bool) -> AgentRunOptions {
        AgentRunOptions {
            auto_approve,
            ..AgentRunOptions::default()
        }
    }

    #[test]
    fn provider_ids_parse() {
        for provider in AgentProvider::ALL {
            assert_eq!(parse_provider(provider.id()), Some(provider));
        }
        assert_eq!(parse_provider("claude-code"), Some(AgentProvider::Claude));
        assert_eq!(parse_provider("OPENCODE"), Some(AgentProvider::Opencode));
        assert_eq!(parse_provider("gemini"), None);
        assert_eq!(parse_provider(""), None);
    }

    #[test]
    fn opencode_args() {
        let args = build_args(AgentProvider::Opencode, "summarize my notes", &opts(false));
        assert_eq!(args, vec!["run", "summarize my notes"]);

        let args = build_args(AgentProvider::Opencode, "  fix it  ", &opts(true));
        assert_eq!(args, vec!["run", "--auto", "fix it"]);
    }

    #[test]
    fn opencode_resume_uses_session_id_over_continue() {
        let opts = AgentRunOptions {
            continue_session: true,
            resume_session_id: Some("ses_abc".into()),
            ..Default::default()
        };
        let args = build_args(AgentProvider::Opencode, "more", &opts);
        assert_eq!(args, vec!["run", "--session", "ses_abc", "more"]);

        let continue_only = AgentRunOptions {
            continue_session: true,
            ..Default::default()
        };
        let args = build_args(AgentProvider::Opencode, "more", &continue_only);
        assert_eq!(args, vec!["run", "--continue", "more"]);
    }

    #[test]
    fn claude_args() {
        let args = build_args(AgentProvider::Claude, "draft a daily note", &opts(false));
        assert_eq!(
            args,
            vec![
                "-p",
                "--permission-mode",
                "acceptEdits",
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "draft a daily note",
            ]
        );

        let args = build_args(
            AgentProvider::Claude,
            "draft",
            &AgentRunOptions {
                auto_approve: true,
                resume_session_id: Some("uuid".into()),
                ..Default::default()
            },
        );
        assert_eq!(
            args,
            vec![
                "-p",
                "--resume",
                "uuid",
                "--permission-mode",
                "bypassPermissions",
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "draft",
            ]
        );
    }

    #[test]
    fn codex_args() {
        let args = build_args(AgentProvider::Codex, "refactor", &opts(true));
        assert_eq!(args, vec!["exec", "--full-auto", "refactor"]);
        let args = build_args(
            AgentProvider::Codex,
            "refactor",
            &AgentRunOptions {
                continue_session: true,
                ..Default::default()
            },
        );
        assert_eq!(args, vec!["exec", "--continue", "refactor"]);
    }

    #[test]
    fn claude_text_events_stream() {
        let line = r#"{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"Hello","partial":true}],"model":"claude-4","role":"assistant"}}"#;
        match parse_claude_line(line) {
            Some(ClaudeLine::Text(t)) => assert_eq!(t, "Hello"),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn claude_result_event_has_session_and_summary() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":12400,"session_id":"abc-123","num_turns":3,"result":"success","total_files_modified":2,"total_lines_added":34,"total_lines_removed":9}"#;
        match parse_claude_line(line) {
            Some(ClaudeLine::Ended {
                session_id,
                summary,
            }) => {
                assert_eq!(session_id.as_deref(), Some("abc-123"));
                let s = summary.expect("summary");
                assert!(s.contains("finished"), "{s}");
                assert!(s.contains("2 files modified"), "{s}");
                assert!(s.contains("+34/−9 lines"), "{s}");
            }
            other => panic!("expected Ended, got {other:?}"),
        }
    }

    #[test]
    fn claude_non_text_lines_ignored() {
        assert!(parse_claude_line("not json").is_none());
        assert!(
            parse_claude_line(r#"{"type":"system","subtype":"init","platform":"darwin-x64"}"#)
                .is_none()
        );
        assert!(
            parse_claude_line(
                r#"{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}"#
            )
            .is_none()
        );
    }

    #[test]
    fn git_status_parses_plain_modified_untracked() {
        let out = " M notes/alpha.md\n?? beta.md\nA  staged.md";
        assert_eq!(
            parse_git_status(out),
            vec!["notes/alpha.md", "beta.md", "staged.md"],
        );
    }

    #[test]
    fn git_status_parses_rename_and_quoted() {
        // rename reports the target; a quoted path (core.quotePath) is
        // unescaped back to its literal filename.
        let out = "R  old.md -> new.md\n?? \"we\"ird.md\"";
        assert_eq!(parse_git_status(out), vec!["new.md", "we\"ird.md"]);
    }

    #[test]
    fn git_status_empty() {
        assert!(parse_git_status("").is_empty());
        // malformed: too short, or no space separator at index 2
        assert!(parse_git_status("A").is_empty());
        assert!(parse_git_status("123bad\r\n").is_empty());
    }

    #[test]
    fn path_search_finds_existing_file() {
        let dir = std::env::temp_dir().join("quire-agent-test");
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join("fake-opencode");
        std::fs::write(&path, "#!/bin/sh\n").expect("write fake binary");
        let entries = split_path(&dir.to_string_lossy());
        assert_eq!(find_in_path(&entries, "fake-opencode"), Some(path));
        assert_eq!(find_in_path(&entries, "missing-opencode"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn split_path_ignores_blanks() {
        let parts = split_path("/a::/b:/c");
        assert_eq!(parts, vec!["/a", "/b", "/c"]);
    }
}

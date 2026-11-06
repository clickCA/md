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
            // --verbose is required by `-p --output-format stream-json`
            // (without it the CLI exits with an error before running).
            args.push("--output-format".into());
            args.push("stream-json".into());
            args.push("--verbose".into());
            args.push("--include-partial-messages".into());
        }
        AgentProvider::Opencode | AgentProvider::Codex => {}
    }

    args.push(prompt.trim().to_string());
    args
}

fn provider_base_args(provider: AgentProvider) -> &'static [&'static str] {
    match provider {
        // --format json streams structured events (tool calls, session id)
        // that the parsers in this module normalize for the panel.
        AgentProvider::Opencode => &["run", "--format", "json"],
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
// Stream normalisation (Claude Code stream-json + opencode --format json)
// ---------------------------------------------------------------------------

/// A short human-readable detail for a tool-call input object: the first
/// recognisable field (file path, command, pattern, …). Covers Claude's
/// snake_case and opencode's camelCase input styles. Truncated so one huge
/// Bash command can't flood the panel.
fn tool_detail(input: &serde_json::Value) -> Option<String> {
    const KEYS: [&str; 10] = [
        "file_path",
        "filePath",
        "command",
        "pattern",
        "path",
        "url",
        "query",
        "description",
        "skill",
        "name",
    ];
    let obj = input.as_object()?;
    let raw = KEYS
        .iter()
        .find_map(|k| obj.get(*k).and_then(|v| v.as_str()))
        .filter(|s| !s.trim().is_empty())?;
    let mut detail = raw.trim().to_string();
    const CAP: usize = 160;
    if detail.chars().count() > CAP {
        detail = detail.chars().take(CAP).collect::<String>() + "…";
    }
    Some(detail)
}

/// What a single line of `claude -p --output-format stream-json` means to us.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaudeLine {
    /// Human-readable assistant text (streamed; `partial: true` runs too).
    Text(String),
    /// A tool the assistant invoked, with a short detail (file path,
    /// command, pattern…).
    Tool { name: String, detail: String },
    /// The terminal `result` event — carries the session id + summary.
    Ended {
        session_id: Option<String>,
        summary: Option<String>,
    },
}

/// Parse one stdout line from Claude Code's `stream-json` output into
/// everything the transcript can show — one assistant message can carry
/// text *and* tool calls, hence the vec. Non-text lines (system init, tool
/// results Claude handled on its own, garbage) return an empty vec instead
/// of leaking raw JSON into the panel.
pub fn parse_claude_line(line: &str) -> Vec<ClaudeLine> {
    let line = line.trim();
    if !line.starts_with('{') || !line.ends_with('}') {
        return Vec::new();
    }
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("assistant") => {
            let Some(content) = v.get("message").and_then(|m| m.get("content")) else {
                return Vec::new();
            };
            let mut out = Vec::new();
            let mut text = String::new();
            if let Some(blocks) = content.as_array() {
                for block in blocks {
                    match block.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                text.push_str(t);
                            } else if let Some(d) = block.get("delta").and_then(|d| d.as_str()) {
                                text.push_str(d);
                            }
                        }
                        Some("tool_use") => {
                            let name = block
                                .get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or("tool")
                                .to_string();
                            let detail =
                                tool_detail(block.get("input").unwrap_or(&serde_json::Value::Null))
                                    .unwrap_or_default();
                            out.push(ClaudeLine::Tool { name, detail });
                        }
                        _ => {}
                    }
                }
            } else if let Some(s) = content.as_str() {
                text.push_str(s);
            }
            if !text.is_empty() {
                out.insert(0, ClaudeLine::Text(text));
            }
            out
        }
        Some("result") => {
            let session_id = v
                .get("session_id")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let summary = result_summary(&v);
            vec![ClaudeLine::Ended {
                session_id,
                summary,
            }]
        }
        _ => Vec::new(),
    }
}

/// What a single line of `opencode run --format json` means to us. Every
/// event carries the run's session id, so any successful parse yields at
/// least a [`OpencodeLine::Session`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpencodeLine {
    /// Completed assistant text segment (opencode emits finished parts).
    Text(String),
    /// A completed (or failed) tool call with a short human detail.
    Tool { name: String, detail: String },
    /// The session this run belongs to — first one wins; enables precise
    /// `--session` resume instead of best-effort `--continue`.
    Session(String),
    /// A server/session error surfaced by the CLI.
    Error(String),
}

/// opencode's own display title usually embeds the tool name (`Edit
/// notes/a.md`, `Glob "pattern"`); strip that prefix so the panel can
/// render `name · detail` without repeating the name. Titles that don't
/// start with the name (bash's is the raw command) pass through unchanged.
fn strip_tool_prefix<'a>(name: &str, title: &'a str) -> &'a str {
    let title = title.trim();
    let lower = title.to_ascii_lowercase();
    let name_lower = name.to_ascii_lowercase();
    if lower.starts_with(&name_lower) {
        let rest = &title[name_lower.len()..];
        if rest.starts_with(' ') || rest.starts_with('"') || rest.starts_with(':') {
            return rest.trim();
        }
    }
    title
}

/// Parse one stdout line of opencode's `--format json` stream
/// (`{"type":…, "timestamp":…, "sessionID":…, …}` per its `run` command).
/// Unknown event types (`step_start`, `reasoning`, …) and garbage yield no
/// semantic entries; the session id is still harvested when present.
pub fn parse_opencode_line(line: &str) -> Vec<OpencodeLine> {
    let line = line.trim();
    if !line.starts_with('{') || !line.ends_with('}') {
        return Vec::new();
    }
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    if let Some(id) = v
        .get("sessionID")
        .and_then(|s| s.as_str())
        .filter(|s| !s.is_empty())
    {
        out.push(OpencodeLine::Session(id.to_string()));
    }
    match v.get("type").and_then(|t| t.as_str()) {
        Some("text") => {
            let text = v
                .get("part")
                .and_then(|p| p.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if !text.is_empty() {
                out.push(OpencodeLine::Text(text));
            }
        }
        Some("tool_use") => {
            let Some(part) = v.get("part") else {
                return out;
            };
            let Some(name) = part.get("tool").and_then(|t| t.as_str()) else {
                return out;
            };
            let state = part.get("state").unwrap_or(&serde_json::Value::Null);
            // opencode's state.title is its own display string for the call
            // ("Edit notes/a.md", the bash command line); fall back to the
            // shared input-key scan.
            let detail = state
                .get("title")
                .and_then(|t| t.as_str())
                .map(|t| strip_tool_prefix(name, t).to_string())
                .or_else(|| tool_detail(state.get("input").unwrap_or(&serde_json::Value::Null)))
                .unwrap_or_default();
            out.push(OpencodeLine::Tool {
                name: name.to_string(),
                detail,
            });
        }
        Some("error") => {
            let msg = v
                .get("error")
                .and_then(|e| {
                    e.get("data")
                        .and_then(|d| d.get("message"))
                        .and_then(|m| m.as_str())
                        .or_else(|| e.get("name").and_then(|n| n.as_str()))
                })
                .unwrap_or("unknown error");
            out.push(OpencodeLine::Error(msg.to_string()));
        }
        _ => {}
    }
    out
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
    /// One chunk of output (a raw CLI line, or a normalized assistant text
    /// event).
    Output { stream: String, text: String },
    /// A tool call the agent made (edit, bash, grep, …), normalized across
    /// providers so the panel can show live activity.
    Tool { name: String, detail: String },
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
    // Session id observed in the stream (opencode stamps every event with
    // one); lets the next turn resume precisely instead of `--continue`.
    let stream_session: Arc<Mutex<Option<String>>> = Arc::default();

    // stdout reader (provider-specific: claude and opencode emit JSONL)
    let provider = inv.provider;
    let emit = on_event.clone();
    let done = done_tx.clone();
    let result_slot = cli_result.clone();
    let session_slot = stream_session.clone();
    let stdout_reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let line = line.trim_end_matches('\r').to_string();
            match provider {
                AgentProvider::Claude => {
                    for ev in parse_claude_line(&line) {
                        match ev {
                            ClaudeLine::Text(t) => {
                                let _ = emit.send(AgentEvent::Output {
                                    stream: "stdout".into(),
                                    text: t,
                                });
                            }
                            ClaudeLine::Tool { name, detail } => {
                                let _ = emit.send(AgentEvent::Tool { name, detail });
                            }
                            ClaudeLine::Ended {
                                session_id,
                                summary,
                            } => {
                                *result_slot.lock().unwrap() = Some((session_id, summary));
                            }
                        }
                    }
                }
                AgentProvider::Opencode => {
                    for ev in parse_opencode_line(&line) {
                        match ev {
                            OpencodeLine::Text(t) => {
                                let _ = emit.send(AgentEvent::Output {
                                    stream: "stdout".into(),
                                    text: t,
                                });
                            }
                            OpencodeLine::Tool { name, detail } => {
                                let _ = emit.send(AgentEvent::Tool { name, detail });
                            }
                            OpencodeLine::Session(id) => {
                                let mut slot = session_slot.lock().unwrap();
                                if slot.is_none() {
                                    *slot = Some(id);
                                }
                            }
                            OpencodeLine::Error(msg) => {
                                let _ = emit.send(AgentEvent::Output {
                                    stream: "stdout".into(),
                                    text: format!("⚠ {msg}"),
                                });
                            }
                        }
                    }
                }
                AgentProvider::Codex => {
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
    // Claude reports its session in the terminal `result` event; opencode
    // stamps every streamed event with the session id.
    let session_id = session_id.or_else(|| stream_session.lock().unwrap().clone());
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
        assert_eq!(args, vec!["run", "--format", "json", "summarize my notes"]);

        let args = build_args(AgentProvider::Opencode, "  fix it  ", &opts(true));
        assert_eq!(args, vec!["run", "--format", "json", "--auto", "fix it"]);
    }

    #[test]
    fn opencode_resume_uses_session_id_over_continue() {
        let opts = AgentRunOptions {
            continue_session: true,
            resume_session_id: Some("ses_abc".into()),
            ..Default::default()
        };
        let args = build_args(AgentProvider::Opencode, "more", &opts);
        assert_eq!(
            args,
            vec!["run", "--format", "json", "--session", "ses_abc", "more"]
        );

        let continue_only = AgentRunOptions {
            continue_session: true,
            ..Default::default()
        };
        let args = build_args(AgentProvider::Opencode, "more", &continue_only);
        assert_eq!(args, vec!["run", "--format", "json", "--continue", "more"]);
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
                "--verbose",
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
                "--verbose",
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
        assert_eq!(
            parse_claude_line(line),
            vec![ClaudeLine::Text("Hello".into())]
        );
    }

    #[test]
    fn claude_tool_use_becomes_a_tool_event() {
        let line = r#"{"type":"assistant","message":{"id":"msg_2","content":[{"type":"tool_use","id":"toolu_1","name":"Edit","input":{"file_path":"/vault/notes/a.md","old_string":"x"}}],"role":"assistant"}}"#;
        let parsed = parse_claude_line(line);
        assert_eq!(
            parsed,
            vec![ClaudeLine::Tool {
                name: "Edit".into(),
                detail: "/vault/notes/a.md".into(),
            }]
        );
    }

    #[test]
    fn claude_message_can_carry_text_and_tools() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Fixing it."},{"type":"tool_use","name":"Bash","input":{"command":"git status"}}],"role":"assistant"}}"#;
        let parsed = parse_claude_line(line);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0], ClaudeLine::Text("Fixing it.".into()));
        assert_eq!(
            parsed[1],
            ClaudeLine::Tool {
                name: "Bash".into(),
                detail: "git status".into(),
            }
        );
    }

    #[test]
    fn tool_detail_truncates_long_values() {
        let long = "a".repeat(400);
        let input = serde_json::json!({ "command": long });
        let detail = tool_detail(&input).expect("detail");
        assert_eq!(detail.chars().count(), 161); // 160 + ellipsis
        assert!(detail.ends_with('…'));
    }

    #[test]
    fn claude_result_event_has_session_and_summary() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":12400,"session_id":"abc-123","num_turns":3,"result":"success","total_files_modified":2,"total_lines_added":34,"total_lines_removed":9}"#;
        let parsed = parse_claude_line(line);
        match parsed.as_slice() {
            [
                ClaudeLine::Ended {
                    session_id,
                    summary,
                },
            ] => {
                assert_eq!(session_id.as_deref(), Some("abc-123"));
                let s = summary.as_deref().expect("summary");
                assert!(s.contains("finished"), "{s}");
                assert!(s.contains("2 files modified"), "{s}");
                assert!(s.contains("+34/−9 lines"), "{s}");
            }
            other => panic!("expected one Ended event, got {other:?}"),
        }
    }

    #[test]
    fn claude_non_text_lines_ignored() {
        assert!(parse_claude_line("not json").is_empty());
        assert!(
            parse_claude_line(r#"{"type":"system","subtype":"init","platform":"darwin-x64"}"#)
                .is_empty()
        );
        assert!(
            parse_claude_line(
                r#"{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}"#
            )
            .is_empty()
        );
    }

    #[test]
    fn opencode_text_event_yields_text_and_session() {
        let line = r#"{"type":"text","timestamp":1793967852779,"sessionID":"ses_123","part":{"id":"prt_1","type":"text","text":"All done.\n","time":{"start":1,"end":2}}}"#;
        let parsed = parse_opencode_line(line);
        assert_eq!(
            parsed,
            vec![
                OpencodeLine::Session("ses_123".into()),
                OpencodeLine::Text("All done.".into()),
            ]
        );
    }

    #[test]
    fn opencode_tool_use_uses_state_title_and_strips_name_prefix() {
        // Edit's title is "Edit <path>" — the name prefix is stripped so the
        // panel can render "edit · <path>" without repeating the name.
        let edit = r#"{"type":"tool_use","sessionID":"ses_1","part":{"id":"prt_2","type":"tool","tool":"edit","state":{"status":"completed","input":{"filePath":"notes/a.md"},"title":"Edit notes/a.md","metadata":{"diff":"…"}}}}"#;
        assert_eq!(
            parse_opencode_line(edit),
            vec![
                OpencodeLine::Session("ses_1".into()),
                OpencodeLine::Tool {
                    name: "edit".into(),
                    detail: "notes/a.md".into(),
                },
            ]
        );

        // bash's title is the raw command — nothing to strip.
        let bash = r#"{"type":"tool_use","sessionID":"ses_1","part":{"id":"prt_3","type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"ls -la"},"title":"ls -la"}}}"#;
        assert_eq!(
            parse_opencode_line(bash),
            vec![
                OpencodeLine::Session("ses_1".into()),
                OpencodeLine::Tool {
                    name: "bash".into(),
                    detail: "ls -la".into(),
                },
            ]
        );

        // No title → fall back to the shared input-key scan.
        let no_title = r#"{"type":"tool_use","sessionID":"ses_1","part":{"id":"prt_4","type":"tool","tool":"glob","state":{"status":"completed","input":{"pattern":"**/*.md"}}}}"#;
        assert_eq!(
            parse_opencode_line(no_title),
            vec![
                OpencodeLine::Session("ses_1".into()),
                OpencodeLine::Tool {
                    name: "glob".into(),
                    detail: "**/*.md".into(),
                },
            ]
        );
    }

    #[test]
    fn opencode_error_event_surfaces_the_message() {
        // Real shape captured from opencode 1.19.0.
        let line = r#"{"type":"error","timestamp":1793967852779,"sessionID":"ses_x","error":{"name":"UnknownError","data":{"message":"Unexpected server error."}}}"#;
        assert_eq!(
            parse_opencode_line(line),
            vec![
                OpencodeLine::Session("ses_x".into()),
                OpencodeLine::Error("Unexpected server error.".into()),
            ]
        );
    }

    #[test]
    fn opencode_uninteresting_events_only_yield_session() {
        let step = r#"{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}"#;
        assert_eq!(
            parse_opencode_line(step),
            vec![OpencodeLine::Session("ses_1".into())]
        );
        assert!(parse_opencode_line("not json").is_empty());
        assert!(parse_opencode_line(r#"{"type":"step_finish"}"#).is_empty());
    }

    #[test]
    fn strip_tool_prefix_handles_known_titles() {
        assert_eq!(strip_tool_prefix("edit", "Edit notes/a.md"), "notes/a.md");
        assert_eq!(strip_tool_prefix("glob", "Glob \"*.md\""), "\"*.md\"");
        assert_eq!(strip_tool_prefix("bash", "git status"), "git status");
        assert_eq!(strip_tool_prefix("read", "readme"), "readme"); // no delimiter after name
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

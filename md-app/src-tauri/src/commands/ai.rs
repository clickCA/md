//! Inline AI: single-reply, tool-restricted invocations of the user's own
//! coding-agent CLI — the narrow counterpart to the agent panel (see
//! `docs/adr/2026-11-06-inline-ai-surface.md`). The model returns a
//! candidate string for one selection; it never writes files and never
//! runs mutating tools. The UI diffs the candidate against the selection
//! and applies it only on an explicit Accept, through the normal note
//! write path — git and the sync engine see an ordinary edit.
//!
//! Per-provider "cannot write" enforcement, pinned by tests:
//! - claude: `--max-turns 1` (one assistant reply, no tool round-trips) plus
//!   a `--disallowedTools` list covering the mutating/network core tools.
//! - opencode: `--agent plan` (opencode's read-only agent).
//! - codex: `--sandbox read-only`.
//!
//! The prompt itself is built in the UI (`src/lib/inline-ai.ts`) and passed
//! in whole; this module only transports it and captures the reply text.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::State;
use tauri::ipc::Channel;

use super::agent::{AgentProvider, parse_claude_line, parse_opencode_line, resolve_binary};
use super::blocking;
use crate::error::AppError;

/// How long to wait for each output pipe to close before force-killing the
/// child. Inline replies are small; this only guards a wedged CLI.
const INLINE_PIPE_CAP: Duration = Duration::from_secs(120);

// ---------------------------------------------------------------------------
// Command construction
// ---------------------------------------------------------------------------

/// Tools Claude Code may not use in an inline run. Mutators and network;
/// read-only tools stay available but the prompt supplies the text inline,
/// so a well-behaved reply never needs them.
const CLAUDE_DENIED_TOOLS: &str = "Edit,Write,NotebookEdit,Bash,Task,WebFetch,WebSearch";

/// The non-interactive, cannot-write argv for an inline reply. The prompt is
/// the final positional argument. Flag facts are pinned by `build_inline_args`
/// tests, exactly like the agent panel's argv.
pub fn build_inline_args(provider: AgentProvider, prompt: &str) -> Vec<String> {
    let mut args: Vec<String> = match provider {
        AgentProvider::Claude => vec![
            "-p".into(),
            "--max-turns".into(),
            "1".into(),
            "--disallowedTools".into(),
            CLAUDE_DENIED_TOOLS.into(),
            // stream-json on stdout; --verbose is required by -p
            // --output-format stream-json on current CLIs (see agent.rs).
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
        ],
        // plan is opencode's read-only agent: no file edits.
        AgentProvider::Opencode => vec![
            "run".into(),
            "--format".into(),
            "json".into(),
            "--agent".into(),
            "plan".into(),
        ],
        // read-only sandbox: the CLI can read the worktree but not write it.
        AgentProvider::Codex => vec!["exec".into(), "--sandbox".into(), "read-only".into()],
    };
    args.push(prompt.trim().to_string());
    args
}

// ---------------------------------------------------------------------------
// Tauri surface
// ---------------------------------------------------------------------------

/// One chunk of streamed model text (a normalized assistant message for
/// claude/opencode, a raw line for codex).
#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiEvent {
    Text { text: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiInlineRunDto {
    /// The candidate replacement text. Empty unless `status` is `"done"`.
    pub text: String,
    pub status: String,
    /// Provider session id, when the CLI reports one (claude `result`,
    /// opencode `sessionID`) — the UI may resume a follow-up.
    pub session_id: Option<String>,
    /// Human-readable failure (stderr tail) when `status` is `"error"`.
    pub error: Option<String>,
    pub duration_ms: u64,
}

/// The one active inline run, so `ai_stop` can cancel it (same invariant
/// and shape as the agent panel's state).
#[derive(Default)]
pub struct AiState {
    active: Mutex<Option<Arc<ActiveRun>>>,
}

struct ActiveRun {
    cancel: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
}

/// Run one inline reply. Streams `AiEvent`s over `on_event` as the model
/// produces text; resolves with the complete candidate when the process
/// exits. At most one inline run at a time.
#[tauri::command]
#[tracing::instrument(level = "debug", err, skip(on_event, state))]
pub async fn ai_inline(
    dir: String,
    provider: String,
    prompt: String,
    on_event: Channel<AiEvent>,
    state: State<'_, AiState>,
) -> Result<AiInlineRunDto, AppError> {
    let provider = super::agent::parse_provider(&provider)
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

    let cancel = Arc::new(AtomicBool::new(false));
    let child = Arc::new(Mutex::new(None::<Child>));
    {
        let mut active = state.active.lock().unwrap();
        if active.is_some() {
            return Err(AppError::Internal(
                "an inline AI run is already in progress".into(),
            ));
        }
        *active = Some(Arc::new(ActiveRun {
            cancel: cancel.clone(),
            child: child.clone(),
        }));
    }

    let invocation = InlineInvocation {
        provider,
        binary,
        args: build_inline_args(provider, &prompt),
        dir: dir_p,
    };

    let result =
        blocking(move || run_inline_impl(invocation, cancel, child, on_event, INLINE_PIPE_CAP))
            .await;

    *state.active.lock().unwrap() = None;
    result
}

/// Stop the in-flight inline run, if any. Kills the child; the run resolves
/// with `status: "cancelled"`.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn ai_stop(state: State<'_, AiState>) -> Result<(), AppError> {
    let Some(run) = state.active.lock().unwrap().take() else {
        return Ok(());
    };
    run.cancel.store(true, Ordering::SeqCst);
    if let Some(child) = run.child.lock().unwrap().as_mut() {
        let _ = child.kill();
    }
    Ok(())
}

struct InlineInvocation {
    provider: AgentProvider,
    binary: PathBuf,
    args: Vec<String>,
    dir: PathBuf,
}

/// The process part of an inline run — exercised with fake CLIs in tests.
/// Spawns, streams model text to `on_event`, watches `cancel`, reaps the
/// child, and assembles the candidate reply.
fn run_inline_impl(
    inv: InlineInvocation,
    cancel: Arc<AtomicBool>,
    child_slot: Arc<Mutex<Option<Child>>>,
    on_event: Channel<AiEvent>,
    pipe_wait: Duration,
) -> Result<AiInlineRunDto, AppError> {
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

    // Monitor thread: kill on cancel, exit once the child is gone.
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

    let (done_tx, done_rx) = std::sync::mpsc::channel::<&'static str>();

    let text_parts: Arc<Mutex<Vec<String>>> = Arc::default();
    let session: Arc<Mutex<Option<String>>> = Arc::default();
    let stderr_buf: Arc<Mutex<String>> = Arc::default();

    // stdout reader (provider-specific JSONL for claude/opencode, raw for codex)
    let provider = inv.provider;
    let emit = on_event.clone();
    let done = done_tx.clone();
    let parts = text_parts.clone();
    let session_slot = session.clone();
    let stdout_reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let line = line.trim_end_matches('\r').to_string();
            match provider {
                AgentProvider::Claude => {
                    for ev in parse_claude_line(&line) {
                        use super::agent::ClaudeLine;
                        match ev {
                            ClaudeLine::Text(t) => {
                                parts.lock().unwrap().push(t.clone());
                                let _ = emit.send(AiEvent::Text { text: t });
                            }
                            ClaudeLine::Ended {
                                session_id: Some(id),
                                ..
                            } => {
                                *session_slot.lock().unwrap() = Some(id);
                            }
                            _ => {}
                        }
                    }
                }
                AgentProvider::Opencode => {
                    for ev in parse_opencode_line(&line) {
                        use super::agent::OpencodeLine;
                        match ev {
                            OpencodeLine::Text(t) => {
                                parts.lock().unwrap().push(t.clone());
                                let _ = emit.send(AiEvent::Text { text: t });
                            }
                            OpencodeLine::Session(id) => {
                                let mut slot = session_slot.lock().unwrap();
                                if slot.is_none() {
                                    *slot = Some(id);
                                }
                            }
                            _ => {}
                        }
                    }
                }
                AgentProvider::Codex => {
                    let mut with_newline = line;
                    with_newline.push('\n');
                    parts.lock().unwrap().push(with_newline.clone());
                    let _ = emit.send(AiEvent::Text { text: with_newline });
                }
            }
        }
        let _ = done.send("stdout");
    });

    // stderr reader: not streamed (the inline panel shows model text), just
    // captured so a failed run can say why.
    let done = done_tx.clone();
    let err_buf = stderr_buf.clone();
    let stderr_reader = thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let line = line.trim_end_matches('\r');
            if !line.trim().is_empty() {
                err_buf.lock().unwrap().push_str(line);
                err_buf.lock().unwrap().push('\n');
            }
        }
        let _ = done.send("stderr");
    });
    drop(done_tx);

    // Wait for both pipes to close, then force-kill a wedged child.
    let _ = done_rx.recv_timeout(pipe_wait);
    let _ = done_rx.recv_timeout(pipe_wait);
    monitor_stop.store(true, Ordering::SeqCst);
    if let Some(c) = child_slot.lock().unwrap().as_mut() {
        let _ = c.kill(); // no-op if already exited
    }

    let exit_ok = child_slot
        .lock()
        .unwrap()
        .as_mut()
        .and_then(|c| c.wait().ok())
        .is_some_and(|s| s.success());
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();

    let status = if cancel.load(Ordering::SeqCst) {
        "cancelled"
    } else if exit_ok {
        "done"
    } else {
        "error"
    };
    let text = if status == "done" {
        text_parts.lock().unwrap().join("")
    } else {
        String::new()
    };
    let error = if status == "error" {
        let buf = stderr_buf.lock().unwrap();
        let tail: String = buf
            .lines()
            .rev()
            .take(6)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        let tail = tail.trim().to_string();
        Some(if tail.is_empty() {
            format!("{} exited with an error", inv.provider.label())
        } else {
            tail
        })
    } else {
        None
    };

    Ok(AiInlineRunDto {
        text,
        status: status.to_string(),
        session_id: session.lock().unwrap().clone(),
        error,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider_by(id: &str) -> AgentProvider {
        super::super::agent::parse_provider(id).expect("known provider")
    }

    #[test]
    fn claude_inline_args_are_single_reply_no_write() {
        let args = build_inline_args(provider_by("claude"), "rewrite this");
        assert_eq!(
            args,
            vec![
                "-p",
                "--max-turns",
                "1",
                "--disallowedTools",
                CLAUDE_DENIED_TOOLS,
                "--output-format",
                "stream-json",
                "--verbose",
                "rewrite this",
            ]
        );
    }

    #[test]
    fn opencode_inline_args_use_the_read_only_plan_agent() {
        let args = build_inline_args(provider_by("opencode"), "rewrite this");
        assert_eq!(
            args,
            vec!["run", "--format", "json", "--agent", "plan", "rewrite this"]
        );
    }

    #[test]
    fn codex_inline_args_use_a_read_only_sandbox() {
        let args = build_inline_args(provider_by("codex"), "rewrite this");
        assert_eq!(args, vec!["exec", "--sandbox", "read-only", "rewrite this"]);
    }

    #[test]
    fn prompt_is_trimmed_but_never_empty_validated_upstream() {
        let args = build_inline_args(provider_by("codex"), "  spaced  ");
        assert_eq!(args.last().unwrap(), "spaced");
    }

    /// The real process loop driven by fake CLI scripts. Unix-only:
    /// `/bin/sh`, PIDs, and signals.
    #[cfg(unix)]
    mod process {
        use super::*;
        use std::os::unix::fs::PermissionsExt;
        use std::path::Path;
        use tauri::ipc::InvokeResponseBody;

        fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
            let path = dir.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write script");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("chmod +x");
            path
        }

        fn temp_case(name: &str) -> PathBuf {
            let dir =
                std::env::temp_dir().join(format!("quire-ai-proc-{name}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).expect("mkdir");
            dir
        }

        /// A channel that records every streamed event for assertions.
        fn harness() -> (Channel<AiEvent>, Arc<Mutex<Vec<String>>>) {
            let texts: Arc<Mutex<Vec<String>>> = Arc::default();
            let slot = texts.clone();
            let channel = Channel::new(move |body: InvokeResponseBody| {
                if let InvokeResponseBody::Json(s) = body
                    && let Ok(e) = serde_json::from_str::<AiEvent>(&s)
                {
                    match e {
                        AiEvent::Text { text } => slot.lock().unwrap().push(text),
                    }
                }
                Ok(())
            });
            (channel, texts)
        }

        fn invocation(provider: AgentProvider, binary: PathBuf, dir: &Path) -> InlineInvocation {
            InlineInvocation {
                provider,
                binary,
                args: vec![],
                dir: dir.to_path_buf(),
            }
        }

        #[test]
        fn codex_raw_stdout_becomes_the_candidate_text() {
            let dir = temp_case("codex");
            let script = write_script(&dir, "cli", "echo line one; echo line two");
            let (channel, texts) = harness();

            let out = run_inline_impl(
                invocation(provider_by("codex"), script, &dir),
                Arc::new(AtomicBool::new(false)),
                Arc::new(Mutex::new(None)),
                channel,
                Duration::from_secs(5),
            )
            .expect("run resolves");

            assert_eq!(out.status, "done");
            assert_eq!(out.text, "line one\nline two\n");
            assert_eq!(texts.lock().unwrap().len(), 2);
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn claude_jsonl_assistant_events_become_the_candidate_text() {
            let dir = temp_case("claude");
            // A minimal stream-json transcript: one assistant message, then
            // the terminal result event carrying the session id.
            let script = write_script(
                &dir,
                "cli",
                r#"echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello "}]}}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"candidate"}]}}'
echo '{"type":"result","subtype":"success","session_id":"ses_1","is_error":false}'"#,
            );
            let (channel, texts) = harness();

            let out = run_inline_impl(
                invocation(provider_by("claude"), script, &dir),
                Arc::new(AtomicBool::new(false)),
                Arc::new(Mutex::new(None)),
                channel,
                Duration::from_secs(5),
            )
            .expect("run resolves");

            assert_eq!(out.status, "done");
            assert_eq!(out.text, "Hello candidate");
            assert_eq!(out.session_id.as_deref(), Some("ses_1"));
            assert_eq!(
                *texts.lock().unwrap(),
                vec!["Hello ".to_string(), "candidate".to_string()]
            );
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn opencode_jsonl_yields_text_and_session() {
            let dir = temp_case("opencode");
            let script = write_script(
                &dir,
                "cli",
                r#"echo '{"sessionID":"oc_9","type":"text","part":{"type":"text","text":"candidate text"}}'"#,
            );
            let (channel, _texts) = harness();

            let out = run_inline_impl(
                invocation(provider_by("opencode"), script, &dir),
                Arc::new(AtomicBool::new(false)),
                Arc::new(Mutex::new(None)),
                channel,
                Duration::from_secs(5),
            )
            .expect("run resolves");

            assert_eq!(out.status, "done");
            assert_eq!(out.text, "candidate text");
            assert_eq!(out.session_id.as_deref(), Some("oc_9"));
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn nonzero_exit_is_an_error_with_the_stderr_tail() {
            let dir = temp_case("fail");
            let script = write_script(
                &dir,
                "cli",
                "echo thinking... >&2\necho model exploded >&2\nexit 2",
            );
            let (channel, _texts) = harness();

            let out = run_inline_impl(
                invocation(provider_by("codex"), script, &dir),
                Arc::new(AtomicBool::new(false)),
                Arc::new(Mutex::new(None)),
                channel,
                Duration::from_secs(5),
            )
            .expect("run resolves");

            assert_eq!(out.status, "error");
            assert_eq!(out.text, "");
            let err = out.error.expect("error message");
            assert!(err.contains("model exploded"), "{err}");
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn empty_stderr_falls_back_to_a_generic_error() {
            let dir = temp_case("quiet");
            let script = write_script(&dir, "cli", "exit 1");
            let (channel, _texts) = harness();

            let out = run_inline_impl(
                invocation(provider_by("codex"), script, &dir),
                Arc::new(AtomicBool::new(false)),
                Arc::new(Mutex::new(None)),
                channel,
                Duration::from_secs(5),
            )
            .expect("run resolves");

            assert_eq!(out.status, "error");
            assert!(
                out.error
                    .expect("generic error")
                    .contains("exited with an error")
            );
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn cancel_wins_and_drops_the_candidate() {
            let dir = temp_case("cancel");
            let script = write_script(&dir, "cli", "echo candidate");
            let (channel, _texts) = harness();
            let cancel = Arc::new(AtomicBool::new(true));

            let out = run_inline_impl(
                invocation(provider_by("codex"), script, &dir),
                cancel,
                Arc::new(Mutex::new(None)),
                channel,
                Duration::from_secs(5),
            )
            .expect("run resolves");

            assert_eq!(out.status, "cancelled");
            assert_eq!(out.text, "");
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn hung_child_holding_a_pipe_is_force_killed_at_the_cap() {
            let dir = temp_case("hang");
            let pid_file = dir.join("child.pid");
            let script = write_script(
                &dir,
                "cli",
                "echo $$ > \"$1\"\ni=0\nwhile [ \"$i\" -lt 300 ]; do sleep 1; i=$((i+1)); done",
            );
            let pid_arg = pid_file.to_string_lossy().into_owned();
            let (channel, _texts) = harness();
            let cancel = Arc::new(AtomicBool::new(false));

            let started = Instant::now();
            let mut inv = invocation(provider_by("codex"), script, &dir);
            inv.args = vec![pid_arg];
            let out = run_inline_impl(
                inv,
                cancel,
                Arc::new(Mutex::new(None)),
                channel,
                Duration::from_millis(400),
            )
            .expect("run resolves");

            let elapsed = started.elapsed();
            assert_eq!(out.status, "error", "force-kill without cancel is an error");
            assert!(
                elapsed >= Duration::from_millis(400),
                "cap engaged: {elapsed:?}"
            );
            assert!(
                elapsed < Duration::from_secs(10),
                "no 120 s block: {elapsed:?}"
            );
            let pid: u32 = std::fs::read_to_string(&pid_file)
                .expect("child recorded its pid")
                .trim()
                .parse()
                .expect("pid");
            assert!(
                !Path::new(&format!("/proc/{pid}")).exists(),
                "force-killed child must be reaped"
            );
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
